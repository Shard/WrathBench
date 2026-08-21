# @wrathbench/sdk

The surface the model programs against. Thin typed wrappers over the module's
HTTP/WebSocket protocol (`module/PROTOCOL.md`), a typed event stream, and a
state cache built purely from events.

The SDK's public shape is part of the harness version (`docs/ARCHITECTURE.md`).
Adding to it is a minor bump. Changing or removing anything exported from
`src/index.ts` is a major bump and wants an ADR under `docs/decisions/`. Two
consequences worth stating: helpers are added because a run needed them, never
in anticipation; and the cache never exposes a field no event carried, because
a field that appears and later becomes trustworthy is a silent contract change.

## At a glance

```ts
import { connect } from "@wrathbench/sdk";

const client = await connect({ baseUrl: "http://worldserver:8086", token: "run-1" });

await client.health();
const session = await client.createSession({ character: "Benchy", race: 1, class: 1 });

await client.say("hello world");
const echo = await client.waitForChat("hello world", { timeout: 5000 });

console.log(client.state.self.position?.value);
await client.logout();
client.close();
```

`connect` opens the event subscription *before* any session exists, on purpose:
`POST /session` blocks for the whole login handshake, so `SMSG_CHAR_ENUM` and
`SMSG_LOGIN_VERIFY_WORLD` arrive while that call is still in flight. Subscribing
first is what makes the state cache complete.

### Client

```ts
connect(options: ConnectOptions): Promise<WrathClient>

class WrathClient {
  readonly token: string
  readonly baseUrl: string
  readonly events: EventStream
  readonly state: StateCache

  health(): Promise<HealthResponse>                                   // GET /health
  createSession(req: Omit<CreateSessionRequest, "token">): Promise<SessionResponse>  // POST /session
  say(text: string): Promise<ActionResponse>                          // POST /action
  deleteSession(): Promise<DeleteSessionResponse>                     // DELETE /session
  logout(): Promise<DeleteSessionResponse>                            // alias
  close(): void                                                       // closes the stream only

  waitForChat(match: string | ((e: ChatEntry) => boolean), o?: WaitForChatOptions): Promise<ChatEntry>
  get selfKey(): string | undefined
}
```

`ConnectOptions`: `baseUrl`, `token`, and optionally `eventsUrl`,
`subscribeEvents` (default true), `requestTimeoutMs` (default 30000 — the
session call blocks up to 20s server-side), `fetchImpl`, `events` (stream
options), `state` (`chatTail`, `notificationTail`).

Helpers stop at `say` and `waitForChat` because that is all the protocol
currently supports.

### Errors: two channels, not quite two transports

- `WrathTransportError` — the request got no readable answer: socket refused,
  timeout, non-JSON body, a 2xx body that does not match the protocol.
- `WrathRequestError` — the module answered `{ ok: false }`. Carries `status`,
  `code`, `body`, and `kind`:
  - `kind: "request"` — your call was wrong (`token_in_use`, `no_session`,
    `not_in_world`, `unsupported_action`, …).
  - `kind: "game"` — the *server* decided (`char_create_failed_code_<N>` — the
    numeric code is parsed out into `charCreateResultCode` — plus `login_failed`
    and `timeout`). These come back as HTTP only because `POST /session` is
    synchronous; the same outcome is also on the event stream.

Everything the server decides *after* an action is acked never appears as an
error at all. It arrives as an event, because that is how a client would learn
of it — a muted `say` is a `SMSG_NOTIFICATION`, not a 4xx.

Unknown error codes parse fine; `ErrorCode` is a widened string union so a new
module code costs autocompletion, not correctness.

### Event stream

```ts
class EventStream implements AsyncIterable<StreamEvent> {
  connect(): Promise<void>
  close(): void
  get connected(): boolean
  get gaps(): number

  on(opcode, handler): Unsubscribe        // typed per opcode
  once(opcode, handler): Unsubscribe
  onAny(handler): Unsubscribe
  waitFor(predicate, o?: WaitForOptions): Promise<StreamEvent>
  waitForOpcode(opcode, o?: WaitForOptions): Promise<EventByOpcode[K]>
  recent(limit?: number): StreamEvent[]
  ingest(frame: string): void             // feed a raw frame (replay / tests)
  [Symbol.asyncIterator]()                // from subscription forward
}
```

Every event carries `seq`, `opcode`, `opcodeId`, `ts`, `data`, exactly as
PROTOCOL.md defines them.

`waitFor` searches the retained buffer (default 500 events) *before* waiting,
so a wait issued after an action was acked can still find an event that arrived
during the call. `{ sinceSeq }` bounds how far back it looks;
`{ includeBuffered: false }` turns history off; `{ timeout }` (default 10s)
rejects with `EventTimeoutError`; `{ signal }` accepts an `AbortSignal`.

Three ways an event can be less than fully typed, none of which drop it:

- `data` is `{ decodeError: true }` — the module could not decode a whitelisted
  packet. Use `isDecodeError(event.data)`.
- `schemaError` is set — the opcode is whitelisted but the payload did not match
  this SDK revision's schema. `isEvent(event, opcode)` returns false for these,
  so narrowing gives you real fields or nothing.
- the opcode is unknown to this revision — it arrives as an `UnknownEvent` with
  `data` unvalidated, so an SDK built against today's whitelist keeps streaming
  when the whitelist widens.

Two synthetic opcodes, lowercase so they can never collide with an `SMSG_*`:

- `stream_gap` — the stream reconnected across a hole. `data` is
  `{ fromSeq, toSeq, missing }`. Never suppressed: a cache is only as
  trustworthy as the stream it was fed. A `seq` that *restarts* (the session was
  torn down and recreated under the same token) is re-baselined, not reported
  as a gap.
- `stream_error` — a frame arrived that was not a readable event envelope.

### State cache

`client.state` is a `StateCache`: a pure fold over the stream.

```ts
state.self          // { guid, name, level?, position?, health?, power? }
state.characters    // Observed<CharacterSummary[]> | undefined  (from SMSG_CHAR_ENUM)
state.names         // Map<guidKey, Observed<string>>            (from SMSG_NAME_QUERY_RESPONSE)
state.nearby        // Map<guidKey, NearbyObject>
state.chat          // readonly ChatEntry[]  (bounded tail)
state.notifications // readonly NotificationEntry[]
state.motd          // Observed<string[]> | undefined
state.gaps          // readonly GapRecord[]  — non-empty means incomplete
state.lastSeq, state.eventCount
state.nameOf(guid), state.snapshot()
StateCache.replay(events, { seed })
```

Every observed field group is an `Observed<T> = { value, seq, ts }`, so
staleness is legible rather than implied. In the Stage-2 slice
`self.position` is written exactly once, by `SMSG_LOGIN_VERIFY_WORLD`, and a
reader can see how old it is.

Two rules the tests enforce:

1. **Nothing is invented** (`docs/CONTRACTS.md`). `self.health` and `self.power`
   are `undefined`, not `0`, because no whitelisted opcode carries them.
   `nearby` is empty rather than populated from chat senders — knowing who spoke
   is not knowing who is in range. A guid learned from a name query goes in
   `names`, which claims nothing spatial.
2. **Replayable.** `StateCache.replay(events, { seed })` reproduces the live
   cache exactly. The one input that is not an event is the seed — our own guid
   and name, which arrive in the `POST /session` response because no `SMSG_*`
   says "you are guid N". It is recorded on `state.seed` so a replay is explicit
   about it.

**Extension point for the coming update-object events.** `nearby` is a
guid-keyed map whose entries use the same `Observed<T>` field groups as `self`,
and `apply()` is a switch on opcode. Landing object updates means: add the
schema in `src/protocol.ts`, add one `case` in `src/state.ts` writing through
`upsertNearby()`, add fields to `NearbyObject`/`SelfState`. No existing shape
moves and no caller changes.

## Running things

```bash
bun test sdk                 # 57 tests, no game stack needed
bunx tsc --noEmit -p sdk     # strict typecheck of src, test and examples

# live check, needs the stack up; not part of bun test
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-slice.ts
```

Tests run against an in-process `Bun.serve` stub (`test/server.ts`) that speaks
the same HTTP and WebSocket shapes and replays fixture frames. All fixtures are
hand-written from PROTOCOL.md with invented names — nothing is captured from a
running game (`CLAUDE.md`).

## Dependencies

Zod, and only at the external boundary: `src/protocol.ts` validates module
messages and hands plain TypeScript types to everything downstream. Transport is
Bun's built-in `fetch` and `WebSocket`.
