# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability). If that is unavailable to you, mail
mark@afrotoss.com. Either way you get an acknowledgement within a week. There
is no further SLA — this is one operator's research project, not a product with
a response team.

## What is in scope

- `module/` — the HTTP/WebSocket bridge the module opens inside the worldserver.
- `sdk/` and `runner/` — the SDK, the agent loop, and the snippet sandbox.
- `dashboard/` and its publisher — the public static site and the projection
  that produces it.

## What is not, and why

The lab is private. No game client can connect and the game ports are never
exposed to a network anyone else is on (`docs/DATA-AND-LEGAL.md`). So a report
about AzerothCore or about WoW 3.3.5a itself has nowhere to land here; take
those upstream. What *is* meaningful is the module's own surface, because that
is the only door: what it serves, who may call it, and what a caller can reach
that it should not. `module/PROTOCOL.md` is the authority on what that surface
exposes, including its bearer-credential classes.

Two other things are worth a report even though they are not memory-safety
bugs: anything that lets an agent observe or act beyond the contracts in
`docs/CONTRACTS.md`, and anything in the published dashboard that leaks what
`docs/DATA-AND-LEGAL.md` says must never leave the lab.
