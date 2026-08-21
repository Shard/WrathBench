# Data Handling and Legal Posture

This is a summary of the project's posture, not legal advice. Get a lawyer's view before anything becomes public.

## Posture

- The repository contains no Blizzard-owned material: no client files, no MPQ or DBC data, no extracted maps, no game text, no trajectory logs (which contain game text).
- Contributors supply their own 3.3.5a client for data extraction. The extraction runs on the host and writes into `data/`, which is gitignored at the directory level and mounted into containers as volumes.
- No public play endpoint. The server is reachable only from the runner on a private network.
- No recruited human players, no money, no distribution of a client or a server.
- Research framing: the output is findings, tooling, and eventually a write-up, not a playable service.
- Retail, Warden, and any Blizzard service are never touched.

This differs materially from the cases Blizzard has pursued (public servers at scale, commercial bot vendors against retail). It is not zero risk.

## Repository hygiene

- `data/` is gitignored. Everything Blizzard-derived goes there: client extracts, the wiki dump and bundle, runs and trajectories, sqlite stores.
- The worldserver image contains AzerothCore and our module. It never contains client data; that is mounted at run time.
- Before any part of the monorepo is split out for publication, the history of that part is checked for accidental data. Directory-level gitignore is the first line of defence; the split is the second.

## Publishing, later

- Metrics, harness code, and documentation: fine.
- Trajectory logs: contain quest text, NPC names, and item names. If published, minimise verbatim game text: IDs and coded names rather than titles and descriptions, or redaction. Decide with legal input.
- The wiki bundle: never published. Each contributor builds their own from their own dump.
- The write-up should state plainly that the benchmark runs on the community reconstruction of 3.3.5a and that no Blizzard material is distributed.

## Licences

- `module/`: AGPL-3.0, inherited from AzerothCore.
- `sdk/`, `runner/`, `wiki/`, `infra/`: MIT. These communicate with the module over a network boundary and do not link against it.
