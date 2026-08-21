# Client data extraction

The worldserver needs map geometry, collision, navigation meshes and DBCs that
only exist inside a WoW client. `infra/extract-client-data.sh` produces them
from a client you supply locally. It runs on the host, once, and writes into
`data/client`, which is gitignored. Nothing it produces may ever enter git; see
`docs/DATA-AND-LEGAL.md`.

```
./infra/extract-client-data.sh /path/to/wow-client [output-dir]
```

Output defaults to `<repo>/data/client`. The script refuses an output path that
is inside the repository but outside `data/`.

## What you need

- A full **3.3.5a build 12340** client install: the directory containing
  `Data/`, with `common.MPQ`, `common-2.MPQ`, `expansion.MPQ`, `lichking.MPQ`,
  `patch.MPQ` and an `enUS` or `enGB` locale folder holding
  `locale-<locale>.MPQ`. Optional `patch-2..5.MPQ` are used if present.
  The build number lives inside the MPQs and cannot be checked from the shell:
  the extractor prints `Detected client build:` on the maps stage, and it must
  say 12340. Anything else produces data the pinned AzerothCore will not load.
  If the install has both locales, DBCs come from `enGB`, because that is first
  in the extractor's locale list.
- Docker, and the `wrathbench/tools` image. Build it from the repo root if it
  is missing (the script tells you the same thing):
  `docker build -f infra/docker/server.Dockerfile --target tools -t wrathbench/tools .`
- Roughly 30 GB free at the output path. Most of that is the transient
  `Buildings/` staging directory the vmap extractor writes and the assembler
  consumes; the script deletes it once the assembler succeeds, so the resting
  footprint is far smaller.

The client is mounted read-only. Containers run as the invoking user, so the
output is owned by you rather than root.

## What it does

Three stages, each using AzerothCore's own tools from `deps/azerothcore` at the
pinned commit, run with the output directory as the working directory:

1. **maps** — `map_extractor -i /client -o .` writes `dbc/`, `maps/` and
   `Cameras/` in one pass.
2. **vmaps** — `vmap4_extractor -d /client/Data/` writes `Buildings/`, then
   `vmap4_assembler Buildings vmaps` turns it into `vmaps/`. `Buildings/` is
   deleted afterwards.
3. **mmaps** — `mmaps_generator --config /mmaps-config.yaml --threads N` builds
   `mmaps/` from `maps/` and `vmaps/`. Threads default to `nproc` capped at half
   the machine's memory in gigabytes: each worker holds a tile's Recast
   heightfield, so the ceiling is memory, not cores. Override with
   `MMAPS_THREADS`, counting roughly two gigabytes per thread.

Tool output is streamed but not line-buffered, so progress percentages arrive in
chunks. A quiet stage is not a hung one.

The resulting layout under the output directory is what the worldserver expects
as its `DataDir`:

```
Cameras/  dbc/  maps/  mmaps/  vmaps/
```

Rough expectations, all approximate and machine-dependent: maps and DBCs are a
couple of gigabytes and take tens of minutes; vmaps are a few gigabytes and take
under an hour, with a much larger `Buildings/` in flight; mmaps take hours and
scale with thread count, and are the reason the script prints per-stage
timestamps and streams tool output.

## Resuming and redoing

Each stage writes a marker file (`.extracted-maps`, `.extracted-vmaps`,
`.extracted-mmaps`) only after its last command succeeds. A re-run skips stages
whose marker is present, so a killed run resumes at the stage that failed.

A marker is removed again when its stage starts, so a marker present always
means the outputs behind it are complete, including across a `--force` run that
is interrupted. A stage without a marker wipes its own outputs before it re-runs. Half-written
`.map` or `.vmtree` files are worse than none, and `vmap4_extractor` refuses to
start at all if `Buildings/` is left dirty. Never hand-create a marker to skip a
stage you interrupted.

`--force` clears the skip logic and redoes all three stages. To redo one stage,
delete its marker and re-run.

## Environment overrides

- `MMAPS_THREADS` — mmaps worker threads (default `nproc`).
- `WRATHBENCH_TOOLS_IMAGE` — tools image (default `wrathbench/tools`).
- `MMAPS_CONFIG` — host path to `mmaps-config.yaml`. Defaults to the copy in the
  pinned submodule, which is mounted into the container because AzerothCore's
  tools image ships the binaries but not necessarily that file.
- `MIN_FREE_GB` — free-space floor for the preflight (default 30).
- `DRY_RUN=1` — print the docker invocations instead of running them.
