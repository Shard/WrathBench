# ADR-0014: Synthetic session-state event on WebSocket reattach

Status: Demoted: see module/PROTOCOL.md (`/events`, `WB_SESSION_STATE`). Date: 2026-08-21.

An implementation note on the event stream: a reattaching subscriber receives one synthetic `WB_SESSION_STATE` carrying only what `SMSG_LOGIN_VERIFY_WORLD` would, because events are fanned out live with no replay. PROTOCOL.md owns the shape and the seq/fan-out rules.
