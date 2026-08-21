# mod-wrathbench wire protocol

The module exposes a small HTTP/WebSocket surface inside the worldserver. The SDK
is generated against this document, so shapes are exact. This is the Stage-2
vertical slice (PHASE-0): session lifecycle, one action (`say`), and a filtered
outbound event stream. It is not the full action set.

Transport: plain HTTP/1.1 and RFC6455 WebSocket on `WrathBench.BindAddress:Port`
(default `0.0.0.0:8086`), reachable only from inside the private compose network.
All request and response bodies are JSON (`Content-Type: application/json`).

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
  "guid": 1,                  // character low GUID (raw ObjectGuid value)
  "inWorld": true
}
```

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

Dispatch one action. Slice supports `say`. Acks that the opcode was synthesized
and queued; the game result (the chat echo, or an error) arrives on the WebSocket.

Request:
```json
{ "token": "run-abc123", "action": "say", "text": "hello world" }
```

Success `200`:
```json
{ "ok": true, "action": "say", "token": "run-abc123" }
```

Errors:
- `400 {"ok":false,"error":"missing_token"}`
- `400 {"ok":false,"error":"unsupported_action","action":"<x>"}`
- `404 {"ok":false,"error":"no_session"}`
- `409 {"ok":false,"error":"not_in_world"}`
- `409 {"ok":false,"error":"no_player"}`

The say language is chosen server-side from the character's team (Common for
Alliance, Orcish for Horde); the caller does not supply it. A client-visible
rejection (e.g. muted) comes back as a `SMSG_NOTIFICATION` event, not an HTTP error.

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
| `SMSG_NAME_QUERY_RESPONSE` | 0x051 | `{ "guid": <u64>, "found": <bool>, "name": <string?> }` |
| `SMSG_MESSAGECHAT` | 0x096 | `{ "type": <u8>, "language": <i32>, "senderGuid": <u64>, "message": <string>, "chatTag": <u8> }` |

`SMSG_MESSAGECHAT.data` is decoded for the `CHAT_MSG_SAY`-shaped layout (the one
the slice produces). Other chat sub-types share the opcode but vary the header;
they will be decoded as the action set grows.

## Audit log

Per session, a JSONL file at `WrathBench.AuditDir/<token>.jsonl`. Every action
dispatched and every event served is appended as:
```json
{ "ts": 1755792000123, "session": "run-abc123", "kind": "action"|"event", "payload": { ... } }
```
`payload` for `event` is the exact event object sent on the WebSocket; for
`action` it is a short record of the dispatched opcode. This is the trajectory's
ground truth and the evidence the contracts held (docs/CONTRACTS.md).
