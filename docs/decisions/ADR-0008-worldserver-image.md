# ADR-0008: Worldserver image adapted from upstream's Dockerfile

Status: Accepted. Date: 2026-08-21.

## Context
Phase 0 needs a worldserver image with `module/` compiled in, plus authserver and extraction-tool images. AzerothCore ships its own multi-stage Dockerfile (`apps/docker/Dockerfile`) that its compose setup and CI use. Our sources come from the pinned submodule, not a clone, and the module lives outside the AzerothCore tree.

## Decision
`infra/docker/server.Dockerfile` is a close adaptation of upstream's Dockerfile with build context at our repo root. It copies the submodule's sources plus `module/` as `modules/mod-wrathbench`, and keeps upstream's stage names, Ubuntu 24.04 base, clang+Ninja toolchain, runtime user (`acore`, uid 1000), and filesystem layout (`/azerothcore/env/dist/...`) unchanged. Two departures: `-DWITHOUT_GIT=1` because a submodule checkout has no usable `.git` inside the tree (upstream bind-mounts its repo's `.git`; our pin is the submodule pointer and `infra/PINS.md`), and the ccache BuildKit cache mount is raised to 10G (upstream's 1G thrashes on a full core build, and module iteration is the hot path).

## Alternatives
- A bespoke Dockerfile: smaller, but forfeits upstream's tested layout and makes every AzerothCore docker fix a manual port. Divergence from upstream needs a reason; none existed.
- Building with upstream's Dockerfile directly and injecting the module by overlay or bind mount: the module must be compiled in (static linkage), so it has to be present at CMake time inside the build context.
- Debug or plain Release build type: kept upstream's RelWithDebInfo; symbols matter when the module crashes the worldserver.

## Consequences
- Cold build is a full core compile (tens of minutes); warm rebuilds after module edits recompile only the changed objects via the ccache mount shared across builds.
- Upstream Dockerfile changes are easy to diff against ours when bumping the submodule pin.
- Version strings report `unknown/Archived` because of `WITHOUT_GIT`; the authoritative pin is the submodule pointer.
- A `db-import` target is kept alongside the three required ones because upstream's boot flow expects a dbimport step and the binary is built anyway.
