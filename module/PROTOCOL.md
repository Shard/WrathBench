# mod-wrathbench wire protocol

The module exposes a small HTTP/WebSocket surface inside the worldserver. The SDK
is generated against this document, so shapes are exact. This is the Stage-2
vertical slice (PHASE-0): session lifecycle, one action (`say`), and a filtered
outbound event stream. It is not the full action set.

Transport: plain HTTP/1.1 and RFC6455 WebSocket on `WrathBench.BindAddress:Port`
(default `0.0.0.0:8086`), reachable only from inside the private compose network.
All request and response bodies are JSON (`Content-Type: application/json`).

**u64 values are decimal strings.** Every guid the module emits — in responses
and in events (`guid`, `senderGuid`, `targetGuid`, `guids[]`) — is serialized as
a decimal string, e.g. `"17365880163140632581"`. 3.3.5a guids carry a high part
(creatures start at 0xF130...) that exceeds `Number.MAX_SAFE_INTEGER`, so a bare
JSON number would be corrupted by any IEEE-double consumer before it could
react. Consumers should compare guids as strings or parse them as BigInt.
(Counters that cannot exceed 2^53 — `seq`, `ts`, drop counts, `moveId` — remain
JSON numbers.)

Two error channels, deliberately separated (docs/CONTRACTS.md):

- **Transport / request errors** — malformed request, unknown token, wrong state —
  are HTTP non-2xx with a JSON body `{ "ok": false, "error": "<code>", ... }`.
- **Game-level errors** — anything the server decides about a dispatched action —
  are never HTTP errors. They arrive as events on the WebSocket (e.g. a
  `SMSG_CHARACTER_LOGIN_FAILED` or `SMSG_NOTIFICATION` event), because that is how
  a real client would learn of them.

## Endpoints

### GET /health

Module and world status. No auth, no body.

Response `200`:
```json
{
  "ok": true,
  "module": "mod-wrathbench",
  "worldStopped": false,
  "sessions": 1,
  "droppedPackets": 4213,
  "droppedPacketsLive": 37
}
```
- `sessions` — number of live bench sessions.
- `droppedPackets` — lifetime count of outbound packets suppressed because they
  were not on the event whitelist (survives session teardown). Whitelist tuning
  signal for later stages; see the whitelist section below.
- `droppedPacketsLive` — the same count summed across only the currently live
  sessions.

### POST /session

Create (or, if the character already exists, reuse) a character and enter the
world. Blocks until the session reaches the world or fails, up to 20s.

Request:
```json
{
  "token": "run-abc123",     // required, opaque session id chosen by the caller
  "account": "RUNNER",       // optional, defaults to WrathBench.Account
  "character": "Benchy",     // required, character name
  "race": 1,                  // optional, default 1 (Human)
  "class": 1,                 // optional, default 1 (Warrior)
  "gender": 0                 // optional, default 0 (Male)
}
```

Success `200`:
```json
{
  "ok": true,
  "token": "run-abc123",
  "account": "RUNNER",
  "character": "Benchy",
  "guid": "1",                // full ObjectGuid as a decimal string (see u64 note)
  "inWorld": true
}
```

`guid` is the character's full 64-bit ObjectGuid. For players the high part is
zero, so it coincides numerically with the character's low GUID and with the
`senderGuid` of the character's own `SMSG_MESSAGECHAT` events — consumers may
compare them directly (as strings). This response is also the only place the
session's own identity (guid + name) is handed over explicitly; the same guid
reappears on the event stream in the self `SMSG_UPDATE_OBJECT` create block
(`"self": true`), which additionally carries own health/power/position.

Errors:
- `400 {"ok":false,"error":"missing_token"}`
- `400 {"ok":false,"error":"missing_character"}`
- `409 {"ok":false,"error":"token_in_use"}`
- `400 {"ok":false,"error":"unknown_account"}`
- `400 {"ok":false,"error":"socket_setup_failed"}`
- `502 {"ok":false,"error":"char_create_failed_code_<N>","token":...}` — game-level
  char-create rejection (N is the `SMSG_CHAR_CREATE` result code); also surfaced as
  a `SMSG_CHAR_CREATE` event.
- `502 {"ok":false,"error":"login_failed","token":...}`
- `502 {"ok":false,"error":"character_missing_after_create","token":...}`
- `504 {"ok":false,"error":"timeout","token":...}` — the flow did not reach the
  world within 20s.

The login flow the module performs internally, all through the real handlers:
`AddSession` → `SMSG_AUTH_RESPONSE(AUTH_OK)` → `CMSG_CHAR_ENUM` →
[`CMSG_CHAR_CREATE` → `SMSG_CHAR_CREATE` → `CMSG_CHAR_ENUM`] → `CMSG_PLAYER_LOGIN`
→ `SMSG_LOGIN_VERIFY_WORLD`. The caller sees only the final ack.

### POST /action

Dispatch one action. Supported: `say`, `move_to`, `stop`, `face` (`move_to`,
`stop`, `face` added in the movement extension, 2026-08; additive). Acks that
the opcode was synthesized and queued; the game result (the chat echo, an
arrival, or an error) arrives on the WebSocket.

Common errors for every action:
- `400 {"ok":false,"error":"missing_token"}`
- `400 {"ok":false,"error":"unsupported_action","action":"<x>"}`
- `404 {"ok":false,"error":"no_session"}`
- `409 {"ok":false,"error":"not_in_world"}`
- `409 {"ok":false,"error":"no_player"}`
- `410 {"ok":false,"error":"session_gone"}`

#### say

Request:
```json
{ "token": "run-abc123", "action": "say", "text": "hello world" }
```

Success `200`:
```json
{ "ok": true, "action": "say", "token": "run-abc123" }
```

The say language is chosen server-side from the character's team (Common for
Alliance, Orcish for Horde); the caller does not supply it. A client-visible
rejection (e.g. muted) comes back as a `SMSG_NOTIFICATION` event, not an HTTP error.

#### move_to

Walk the character to a world position. The module resolves the position against
the server's navmesh once (the single sanctioned mmaps use, docs/CONTRACTS.md
"Pathing") and then drives the character with the client movement packet
sequence a real client would send (`MSG_MOVE_START_FORWARD`, heartbeats every
~500ms, `MSG_MOVE_STOP`) at the character's real run speed. The caller never
sees the path — only progress and a terminal result event.

Request:
```json
{ "token": "run-abc123", "action": "move_to", "x": -8913.2, "y": -137.6, "z": 80.9 }
```

Success `200` (means "queued and pathing", not "arrived"):
```json
{ "ok": true, "action": "move_to", "token": "run-abc123", "moveId": 1 }
```

Additional error: `400 {"ok":false,"error":"missing_position"}`.

The outcome arrives as a `WB_MOVE_RESULT` event carrying the same `moveId`
(statuses below). A `move_to` issued while a previous one is still running
supersedes it: the old move ends with status `superseded`, then the new path
starts from wherever the character is.

#### stop

Stop moving (sends `MSG_MOVE_STOP` where the character currently is). Always
acks `200 { "ok": true, "action": "stop", "token": ... }`; if a move was in
progress it additionally ends with a `WB_MOVE_RESULT` status `stopped`.

Request: `{ "token": "run-abc123", "action": "stop" }`

#### face

Turn in place (sends `MSG_MOVE_SET_FACING`). Give either an absolute
`orientation` in radians (0 = east/+x, counter-clockwise, normalized to
[0, 2pi)) or a point `x`,`y` to face toward.

Request: `{ "token": "run-abc123", "action": "face", "orientation": 1.57 }`
or `{ "token": "run-abc123", "action": "face", "x": -8900.0, "y": -130.0 }`

Success `200`: `{ "ok": true, "action": "face", "token": ..., "orientation": 1.57 }`
Additional errors: `400 {"ok":false,"error":"missing_face_target"}`,
`409 {"ok":false,"error":"moving"}` (stop first, or supersede with `move_to`).

### DELETE /session

Log the character out. Implemented as a WorldSession-level disconnect of the
parked socket, which triggers the core's `LogoutPlayer(save)` on its next update —
the same path a real client's disconnect at the character takes, so the character
is saved.

Request:
```json
{ "token": "run-abc123" }
```

Success `200`: `{ "ok": true, "token": "run-abc123" }`
Errors: `400 missing_token`, `404 no_session`.

## WebSocket /events?token=...

Upgrade request to `/events` with the session token in the query string. The
server streams that session's whitelisted outbound packets as JSON text frames,
one object per frame. The channel is send-only (server→client); frames the client
sends are ignored. Multiple sockets may subscribe to the same token; each gets
every event.

Delivery guarantees:
- `seq` is per-session and restarts at 0 whenever a token's session is created;
  a restart after reconnecting a token is not a gap. Within one session, `seq`
  on the wire is gapless for a subscriber that stays connected.
- There is no replay: events are fanned out live and never buffered for late or
  reconnecting subscribers. A dropped WS loses the observations emitted while it
  was down, irreversibly (they remain in the audit log, which the agent does not
  get). There is no `?sinceSeq=` — reconnect and treat the world as
  re-observed from the next update packets.
- Subscriber registration happens in the server's WebSocket handshake completion
  handler, before any subsequent request from the caller can be parsed. So: any
  action or `/session` call issued after the client's WS `open` completes will
  have its events delivered to that subscriber. Events emitted concurrently
  with the handshake itself may or may not be seen; open the event stream
  before `POST /session` (as the probes do) and this window is irrelevant.

Every event frame:
```json
{
  "seq": 12,                       // per-session monotonically increasing counter
  "opcode": "SMSG_MESSAGECHAT",    // opcode name
  "opcodeId": 150,                 // numeric opcode (0x096)
  "ts": 1755792000123,             // unix epoch milliseconds
  "data": { ... }                  // opcode-specific, decoded fields (below)
}
```

If a whitelisted packet is truncated or fails to decode, `data` is
`{ "decodeError": true }` but the event is still emitted so the drop is visible.

### Whitelist and `data` shapes

Only these opcodes become events; everything else is dropped and counted in
`/health.droppedPackets`. Field layouts mirror the server-side builders at the
pinned AzerothCore commit.

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_AUTH_RESPONSE` | 0x1EE | `{ "code": <u8> }` |
| `SMSG_CHAR_ENUM` | 0x03B | `{ "count": <u8>, "characters": [ { "guid", "name", "race", "class", "gender", "level" } ] }` |
| `SMSG_CHAR_CREATE` | 0x03A | `{ "result": <u8> }` (0x2F = success) |
| `SMSG_CHARACTER_LOGIN_FAILED` | 0x041 | `{ "reason": <u8> }` |
| `SMSG_LOGIN_VERIFY_WORLD` | 0x236 | `{ "map": <u32>, "x": <f>, "y": <f>, "z": <f>, "o": <f> }` |
| `SMSG_MOTD` | 0x33D | `{ "lineCount": <u32>, "lines": [ <string> ] }` |
| `SMSG_NOTIFICATION` | 0x1CB | `{ "text": <string> }` |
| `SMSG_NAME_QUERY_RESPONSE` | 0x051 | `{ "guid": <guid-string>, "found": <bool>, "name": <string?> }` |
| `SMSG_MESSAGECHAT` | 0x096 | `{ "type": <u8>, "language": <i32>, "senderGuid": <guid-string>, "message": <string>, "chatTag": <u8> }` |

`SMSG_MESSAGECHAT.data` is decoded for the `CHAT_MSG_SAY`-shaped layout (the one
the slice produces). Other chat sub-types share the opcode but vary the header;
they will be decoded as the action set grows.

### Movement/observation extension (2026-08, additive)

Additional whitelisted opcodes:

| opcode | id | `data` fields |
|---|---|---|
| `SMSG_UPDATE_OBJECT` | 0x0A9 | `{ "blocks": <u32>, "objects": [ ... ] }` (shapes below) |
| `SMSG_DESTROY_OBJECT` | 0x0AA | `{ "guid": <guid-string>, "onDeath": <bool> }` |
| `SMSG_CREATURE_QUERY_RESPONSE` | 0x061 | `{ "entry": <u32>, "found": <bool>, "name": <str?>, "subname": <str?>, "type": <u32?>, "rank": <u32?> }` |
| `MSG_MOVE_*` (observed) | various | `{ "guid": <guid-string>, "flags": <u32>, "pos": { "x", "y", "z", "o" } }` |

`MSG_MOVE_*` covers movement of *other* nearby units/players relayed by the
server (START_FORWARD/BACKWARD, STOP, STRAFE, JUMP, TURN, SET_FACING, HEARTBEAT,
FALL_LAND, SWIM, RUN/WALK_MODE). The bench character's own synthesized movement
is not echoed by the server; own position comes from `WB_MOVE_PROGRESS` /
`WB_MOVE_RESULT` below and from the self `SMSG_UPDATE_OBJECT` create block.

`SMSG_COMPRESSED_UPDATE_OBJECT` never appears on this stream: the core
compresses large update packets at socket-write time, below the module's tap,
so the tap always sees the uncompressed `SMSG_UPDATE_OBJECT`.

#### `SMSG_UPDATE_OBJECT.objects[]` shapes

The wire is already delta-shaped and the module preserves that: a full object on
first sight (`create`), sparse field deltas afterwards (`values`). Entries are
one of:

- Create (object entered update range, or initial self spawn):
```json
{
  "update": "create",
  "guid": "12345",
  "objectType": "unit",        // object|item|container|unit|player|gameObject|dynamicObject|corpse
  "self": true,                 // present only on the bench character's own block
  "moveFlags": 0,               // living objects only
  "runSpeed": 7.0,              // living objects only
  "pos": { "x": -8949.9, "y": -132.5, "z": 83.5, "o": 5.2 },
  "targetGuid": "0",            // present when the block carries a target
  "fields": { ... }             // whitelisted update fields, see below
}
```
- Field delta: `{ "update": "values", "guid": <guid-string>, "fields": { ... } }`
- Left update range: `{ "update": "outOfRange", "guids": [ <guid-string>, ... ] }`
  (also `"near"` for the rare NEAR_OBJECTS block, same shape)
- Movement-only block: `{ "update": "movement", "guid": <guid-string>, ...pos/moveFlags }`

`fields` carries only the whitelisted update fields present in the packet's
mask, decoded by name; every other field the server sent is consumed and
dropped (the drop is invisible by design — the client got it, the agent does
not need it, docs/CONTRACTS.md):

- all objects: `entry`, `scale`
- units and players: `health`, `maxHealth`, `power1`..`power7`,
  `maxPower1`..`maxPower7`, `level`, `faction`, `unitFlags`, `displayId`,
  `dynamicFlags`, `npcFlags`, `targetGuid`, `race`, `class`, `gender`,
  `powerType` (the last four unpacked from UNIT_FIELD_BYTES_0)
- players additionally: `playerFlags`
- game objects: `goDisplayId`, `goFlags`, `goFaction`, `goLevel`, `goState`,
  `goType`

Values are the raw client-visible integers from the update stream (health is
whatever the server sends a client — no extra precision is added). A `values`
delta for an object never seen in a `create` decodes with no named fields
(the module, like a client, cannot type it).

Name resolution: on first sight of a creature (by entry) or player (by guid)
the module issues the `CMSG_CREATURE_QUERY` / `CMSG_NAME_QUERY` a real client
would issue on cache miss; the answers arrive as `SMSG_CREATURE_QUERY_RESPONSE`
/ `SMSG_NAME_QUERY_RESPONSE` events. Joining guid/entry to name is the SDK's job.

#### Module-synthesized events

Two event `opcode` values do not correspond to server packets; they are produced
by the module's client-side movement engine (the knowledge a real client has
locally while running). Their `opcodeId`s are outside the real opcode range.

| opcode | id | `data` fields |
|---|---|---|
| `WB_MOVE_PROGRESS` | 0xFF02 | `{ "moveId": <u64>, "pos": { "x","y","z","o" } }` — at most 1/s while moving |
| `WB_MOVE_RESULT` | 0xFF01 | `{ "moveId": <u64>, "status": <str>, "pos": { "x","y","z","o" } }` |

`WB_MOVE_RESULT.status` is one of:
- `arrived` — the server-side character reached the destination; `pos` is the
  server-confirmed position.
- `no_path` — the navmesh has no complete walkable path to the point.
- `too_far` — destination beyond the single-move cap (~250yd straight-line);
  issue intermediate `move_to`s.
- `interrupted` — the move stopped early (death, root, teleport, rejection);
  `pos` is where the character actually is.
- `stopped` — a `stop` action ended the move.
- `superseded` — a newer `move_to` replaced this move.

`WB_MOVE_PROGRESS.pos` is the engine's interpolated position (what a client
would render); `WB_MOVE_RESULT.pos` is read back from the live character, so an
`arrived` result is proof the server accepted the synthesized movement.

## Audit log

Per session, a JSONL file at `WrathBench.AuditDir/<token>.jsonl`. Every action
dispatched and every event served is appended as:
```json
{ "ts": 1755792000123, "session": "run-abc123", "kind": "action"|"event", "payload": { ... } }
```
`payload` for `event` is the exact event object sent on the WebSocket; for
`action` it is a short record of the dispatched opcode. This is the trajectory's
ground truth and the evidence the contracts held (docs/CONTRACTS.md).

Synthesized movement logs one `action` record per `move_to`/`stop`/`face`
request plus one per dispatched movement packet (`op: "move_pkt"` with the
opcode and position), so the packet sequence the "client" sent is fully
reconstructable from the audit log.
