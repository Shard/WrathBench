# Server images

`server.Dockerfile` builds AzerothCore from the pinned submodule (`deps/azerothcore`, see `infra/PINS.md`) with `module/` copied in as `modules/mod-wrathbench`. Build context is the repository root.

## Targets

| Target | Tag | Contents |
|---|---|---|
| `worldserver` | `wrathbench/worldserver` | worldserver binary with mod-wrathbench statically linked, confs |
| `authserver` | `wrathbench/authserver` | authserver binary, confs |
| `db-import` | `wrathbench/db-import` | `dbimport` plus the SQL tree, for database bootstrap |

## Build

From the repository root:

```sh
docker build --target worldserver -t wrathbench/worldserver -f infra/docker/server.Dockerfile .
docker build --target authserver  -t wrathbench/authserver  -f infra/docker/server.Dockerfile .
docker build --target tools       -t wrathbench/tools       -f infra/docker/server.Dockerfile .
docker build --target db-import   -t wrathbench/db-import   -f infra/docker/server.Dockerfile .
```

All targets share one `build` stage, so after the first (~30-60 min) build the others are assembly-only. Object files live in a BuildKit ccache cache mount; editing `module/` and rebuilding recompiles only what changed. `docker builder prune` discards that cache and forces a cold build.

## Layout inside the images

Stock AzerothCore layout (kept identical to upstream on purpose, ADR-0008):

- Binaries: `/azerothcore/env/dist/bin/` (on `PATH`)
- Reference confs: `/azerothcore/env/ref/etc/` — `worldserver.conf.dist`, `authserver.conf.dist`, `dbimport.conf.dist`, and `modules/mod_wrathbench.conf.dist`
- Live confs: `/azerothcore/env/dist/etc/` (a volume; the entrypoint copies ref confs in on first start and materialises `$ACORE_COMPONENT.conf` from its `.dist`)
- Server data directory (dbc/maps/vmaps/mmaps): `/azerothcore/env/dist/data/`, mounted at runtime from `data/client`; not part of the image
- Entrypoint: `/azerothcore/entrypoint.sh` (upstream's), runs as user `acore` (uid 1000)

Verifying the module is present: `worldserver --version`-level boot is not needed; the CMake configure output lists `mod-wrathbench` under the worldserver module graph, and on a real boot the world log prints `mod-wrathbench loaded`.
