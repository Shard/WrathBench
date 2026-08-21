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

const target = await client.waitForNearby(
  (o) => o.objectType?.value === "unit" && o.name !== undefined && o.position !== undefined,
);
const move = await client.moveTo(target.position!.value, { timeout: 60_000 });
if (!move.ok) console.log("could not get there:", move.status);

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
  moveToAsync(point: MovePoint): Promise<MoveToResponse>              // POST /action, ack only
  stop(): Promise<ActionResponse>                                     // POST /action
  face(orientationOrPoint: number | { x, y }): Promise<FaceResponse>  // POST /action
  deleteSession(): Promise<DeleteSessionResponse>                     // DELETE /session
  logout(): Promise<DeleteSessionResponse>                            // alias
  close(): void                                                       // closes the stream only

  waitForChat(match: string | ((e: ChatEntry) => boolean), o?: WaitForChatOptions): Promise<ChatEntry>
  moveTo(point: MovePoint, o?: MoveToOptions): Promise<MoveResult>
  waitForNearby(p: (o: NearbyObject) => boolean, o?: WaitForNearbyOptions): Promise<NearbyObject>
  get selfKey(): string | undefined
}
```

`ConnectOptions`: `baseUrl`, `token`, and optionally `eventsUrl`,
`subscribeEvents` (default true), `requestTimeoutMs` (default 30000 — the
session call blocks up to 20s server-side), `fetchImpl`, `events` (stream
options), `state` (`chatTail`, `notificationTail`).

Helpers stop at `say`, `waitForChat`, `moveTo` and `waitForNearby` because that
is all the protocol currently supports and all the probes have needed.

### Movement

```ts
const result = await client.moveTo({ x, y, z }, { timeout: 90_000 });
if (result.ok) console.log("arrived at", result.position);
else console.log("did not get there:", result.status, "stopped at", result.position);
```

`moveTo` issues `move_to`, then resolves on the `WB_MOVE_RESULT` carrying the
same `moveId`. **Game outcomes are returned, not thrown** (`docs/decisions/ADR-0011`):
`arrived` is `ok: true`; `no_path`, `too_far`, `interrupted`, `stopped` and
`superseded` are `ok: false` with the status intact, and *every* one of them
carries the server-confirmed position the character actually ended at. A
snippet that forgets a `try` should not lose a run to a wall, and "there is no
path there" is an answer, not an error.

Two things still throw:

- `WrathRequestError` — the request was refused before anything moved
  (`missing_position`, `not_in_world`, …).
- `EventTimeoutError` — no result arrived within `timeout` (default 90s: the
  ~250yd single-move cap is ~36s of running, plus the module's server-confirmation
  deadline). That is the *absence* of an outcome — the character may still be
  walking — so it is not dressed up as a `status`.

A `moveTo` issued while another is running supersedes it, and the older call
returns `status: "superseded"`. `stop()` returns as soon as the module has
queued the `MSG_MOVE_STOP` — it does *not* wait for the character to halt; it is
the in-flight `moveTo` that resolves, with `status: "stopped"`, once the stop
has landed. Read the position off that result rather than off the cache right
after `await client.stop()`.
`face()` takes an absolute orientation in radians or a point, and is refused
with code `moving` while a move is running.

`waitForNearby` waits on the *cache*, not on one event: a named creature takes a
create block plus the creature-query answer the module fired on first sight, so
no single event answers "is there a named creature nearby".

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
state.self          // { guid, name, level?, position?, health?, power?, fields }
state.characters    // Observed<CharacterSummary[]> | undefined  (from SMSG_CHAR_ENUM)
state.names         // Map<guidKey, Observed<string>>            (from SMSG_NAME_QUERY_RESPONSE)
state.creatures     // Map<entry, Observed<CreatureInfo>>        (from SMSG_CREATURE_QUERY_RESPONSE)
state.nearby        // Map<guidKey, NearbyObject>                (from SMSG_UPDATE_OBJECT, MSG_MOVE_*)
state.chat          // readonly ChatEntry[]  (bounded tail)
state.notifications // readonly NotificationEntry[]
state.motd          // Observed<string[]> | undefined
state.gaps          // readonly GapRecord[]  — non-empty means incomplete
state.anomalies     // readonly Anomaly[]    — non-empty means contradictory
state.lastSeq, state.eventCount
state.nameOf(guid), state.snapshot()

state.nearbyUnits()          // objects a create block typed unit or player
state.creaturesByEntry(id)   // units whose observed template entry is `id`
state.closest(filter?)       // nearest object with a position, from ours
StateCache.replay(events, { seed })
```

Every observed field group is an `Observed<T> = { value, seq, ts }`, so
staleness is legible rather than implied. That matters most for position: our
own is written by `SMSG_LOGIN_VERIFY_WORLD`, then by our own create block, then
by every `WB_MOVE_PROGRESS` while we walk and by the server-confirmed
`WB_MOVE_RESULT` at the end — and between events it is stale, which the `seq`
says out loud.

The three queries are pure reads. `closest` returns `undefined` when we have no
position of our own, rather than guessing one. They hand back the live cache
entries; `snapshot()` is the frozen copy.

#### How an object in view is built

`create` blocks populate a `NearbyObject`, `values` deltas merge **per field**
(each field keeps the `seq`/`ts` of the block that carried it, so a health
number and the max it is out of can be minutes apart and say so), `movement`
blocks and `MSG_MOVE_*` update positions, `outOfRange` lists and
`SMSG_DESTROY_OBJECT` prune. A `near` block is *not* a removal and does not
prune. `names` and `creatures` are never pruned: the module will not re-issue a
query for an entry it already asked about, so a creature that walks away and
comes back would otherwise be permanently nameless.

Three consequences of "nothing is invented" worth knowing before you read a
field:

- `NearbyObject.position` is a `UnitPosition` (`x,y,z,o`) with **no map id** —
  nothing on the wire carries one for another object. Only `self.position` has
  a `map`, carried from the last `SMSG_LOGIN_VERIFY_WORLD`.
- `health`/`power` are set only when *every* part has been observed. A `values`
  delta routinely carries `health` without `maxHealth`, and which of
  `power1..7` is the character's power depends on `powerType`. Half a gauge is
  not a gauge. The raw parts are always in `obj.fields`, which is where to look
  when a gauge is `undefined`. (Seen live: a level-1 warrior's create block
  carries `powerType: 1` and `maxPower2` but no `power2`, because the current
  value is 0 and zero fields are not in the update mask — so `power` stays
  `undefined` until the first change.)
- A `create` block flagged `self` whose guid contradicts the seeded identity
  does **not** overwrite `self`. It is recorded on `state.anomalies` and filed
  as an ordinary object in view, because the cache cannot tell which of the two
  is wrong and picking silently would make it disagree with the trajectory log.

Two rules the tests enforce:

1. **Nothing is invented** (`docs/CONTRACTS.md`). A field exists only if an
   event carried it: an incomplete gauge stays `undefined` rather than being
   half-filled, an object with no `create` block has no `objectType` (and so is
   not a unit), and a chat sender does not become a nearby object — knowing who
   spoke is not knowing who is in range. A guid learned from a name query goes
   in `names`, which claims nothing spatial.
2. **Replayable.** `StateCache.replay(events, { seed })` reproduces the live
   cache exactly. The one input that is not an event is the seed — our own guid
   and name, which arrive in the `POST /session` response because no `SMSG_*`
   says "you are guid N". It is recorded on `state.seed` so a replay is explicit
   about it.

**Extension point for the coming action sets.** `apply()` is a switch on opcode
and every world write goes through `upsertNearby()`. Landing combat or loot
events means: add the schema in `src/protocol.ts`, add one `case` in
`src/state.ts`, add fields to `NearbyObject`/`SelfState`. Unknown opcodes,
unknown update-block kinds and unknown `data` fields all already pass through
rather than failing, so an SDK built against today's whitelist keeps streaming
when the module's widens.

## Running things

```bash
bun test sdk                 # 89 tests, no game stack needed
bunx tsc --noEmit -p sdk     # strict typecheck of src, test and examples

# live checks, need the stack up; not part of bun test
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-slice.ts
docker compose -f infra/compose.yml exec runner bun sdk/examples/live-move.ts
```

`live-move.ts` is the movement/observation slice end to end: session, wait for a
named creature to arrive on the update stream, walk ~30y toward it, print the
server-confirmed arrival and the closest creature, log out. It retries patiently
while the worldserver is restarting.

Tests run against an in-process `Bun.serve` stub (`test/server.ts`) that speaks
the same HTTP and WebSocket shapes and replays fixture frames. All fixtures are
hand-written from PROTOCOL.md with invented names — nothing is captured from a
running game (`CLAUDE.md`).

## Dependencies

Zod, and only at the external boundary: `src/protocol.ts` validates module
messages and hands plain TypeScript types to everything downstream. Transport is
Bun's built-in `fetch` and `WebSocket`.
