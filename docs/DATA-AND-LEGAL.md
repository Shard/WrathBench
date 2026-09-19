# Data Handling and Legal Red Lines

These are the lines the project does not cross. They are rules, not arguments; they are not legal advice, and they are not relaxed without a qualified opinion first.

## Never in git or any published artefact

- Client files, MPQ archives, DBC data, or anything derived from them (maps, vmaps, mmaps). The server data directory lives under `data/`, gitignored at the directory level and mounted into containers at run time. The repository does not document how to obtain a client or produce that directory.
- The wiki dump or the bundle built from it. Each operator builds their own.
- Trajectory logs. They contain verbatim game text. Where any are published, game prose — quest, gossip, item and mail body text — is redacted; names (items, quests, NPCs, zones) and ids are kept.
- The worldserver image never contains client data.
- The rule binds the history as well as the working tree: anything split out for publication is audited for accidental data before it is pushed.

`minimap/`, our MPQ/BLP reader, ships as tooling only: the tiles it produces stay in `data/` and out of git. The one exception to the line above is those tiles on the public dashboard's map, which are served from the published bucket's `tiles/` prefix, put there by an explicit upload step and never by the snapshot loop; `docs/PUBLIC-DASHBOARD.md` and `infra/cloudflare/README.md` hold the mechanics. Item icons are not an exception and are neither extracted nor served: the dashboard links an item's `item_template.entry` to Wowhead and that site's tooltip script supplies the art in the reader's browser, a request consequence recorded in `docs/PUBLIC-DASHBOARD.md`.

## Never a way for a human to play

- No game client can connect. The game protocol is never exposed; the only outside surface is the MCP, and it is private. Opening it to anyone outside the operator means meeting the posture below — never a way for a human to play, never money, small and framed as research — and it needs a harness that can run more than one session at a time, which is GitHub issue #9 (group tier) and is not built.
- No web client, no spectate-and-type, no interface that amounts to a person playing through an agent.
- The one client login that exists is the operator's own inspection account, created by `infra/spectator-account.ts` on the operator's realm and reached only over a port-forward on the operator's machine. It is how the operator watches a run, not a way for anyone else to play, and it stays in the tree.
- No recruited players, no public realm listing, no advertised server.

## Never money

- Nothing is sold, rented, or gated on payment. No subscriptions, no paid access, no paid priority.
- Inference donations are accepted only for the operator's own runs and never purchase access to anything.

## Never Blizzard's services

- Retail, Battle.net, Warden, and any Blizzard-operated service are never touched or tested against.

## Scale and framing

- Stays small, private, non-commercial, and framed as research: the output is findings, tooling, and write-ups, not a playable service.
- Public write-ups state plainly that the harness runs on the community reconstruction of 3.3.5a (AzerothCore) and that nothing Blizzard-owned is distributed.
- A qualified opinion on the shared-world (community agent) surface was sought and not obtained. That is not a gate: the posture stays the one stated here — small, private, non-commercial, framed as research, nothing Blizzard-owned distributed.

## Licences

- `module/`: GPL-2.0-or-later; see the complete license text in `module/LICENSE`.
- All other original WrathBench code and documentation, including `sdk/`, `runner/`, `dashboard/`, `wiki/`, `minimap/`, `infra/`, and `docs/`: MIT under the root `LICENSE`.
- AzerothCore remains under its own upstream GPL v2 license. WrathBench builds the pinned submodule and copies `module/` into it; neither that relationship nor the root MIT license relicenses AzerothCore, Blizzard assets, or third-party dependencies. See `THIRD-PARTY-NOTICES.md`.
