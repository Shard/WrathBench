# Data Handling and Legal Red Lines

These are the lines the project does not cross. They are rules, not arguments; they are not legal advice, and they are not relaxed without a qualified opinion first.

## Never in git or any published artefact

- Client files, MPQ archives, DBC data, or anything derived from them (maps, vmaps, mmaps). The server data directory lives under `data/`, gitignored at the directory level and mounted into containers at run time. The repository does not document how to obtain a client or produce that directory.
- The wiki dump or the bundle built from it. Each operator builds their own.
- Trajectory logs. They contain verbatim game text. If any are ever published, it is as ids and coded names with prose redacted.
- The worldserver image never contains client data.

## Never a way for a human to play

- No game client can connect. The game protocol is never exposed; the only outside surface is the MCP, and it is private until the community-access prerequisites in `docs/VISION.md` are met.
- No web client, no spectate-and-type, no interface that amounts to a person playing through an agent.
- No recruited players, no public realm listing, no advertised server.

## Never money

- Nothing is sold, rented, or gated on payment. No subscriptions, no paid access, no paid priority.
- Inference donations are accepted only for the operator's own runs and never purchase access to anything.

## Never Blizzard's services

- Retail, Battle.net, Warden, and any Blizzard-operated service are never touched or tested against.

## Scale and framing

- Stays small, private, non-commercial, and framed as research: the output is findings, tooling, and write-ups, not a playable service.
- Public write-ups state plainly that the harness runs on the community reconstruction of 3.3.5a (AzerothCore) and that nothing Blizzard-owned is distributed.

## Before publication (checklist)

- [ ] Git history is scrubbed or the public repository starts from fresh history. Known history contents to remove: client-data extraction script and guide, client-launch and spectator scripts and GM notes (removed from HEAD 2026-08-22, commit d4e60a6), and a named third-party client path under `data/client-source/`.
- [ ] Decide whether `minimap/` (our MPQ/BLP reader) ships publicly or moves to private ops tooling.
- [ ] The history of anything split out for publication is audited for accidental data.
- [ ] A qualified opinion on the shared-world (community agent) surface is obtained before the first outside agent connects.

## Licences

- `module/`: GPL-2.0-or-later; see the complete license text in `module/LICENSE`.
- All other original WrathBench code and documentation, including `sdk/`, `runner/`, `dashboard/`, `wiki/`, `minimap/`, `infra/`, and `docs/`: MIT under the root `LICENSE`.
- AzerothCore remains under its own upstream GPL v2 license. WrathBench builds the pinned submodule and copies `module/` into it; neither that relationship nor the root MIT license relicenses AzerothCore, Blizzard assets, or third-party dependencies. See `THIRD-PARTY-NOTICES.md`.
