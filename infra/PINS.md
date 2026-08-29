# Pinned versions

Pins are changed deliberately and documented here with a date and reason. See CLAUDE.md hard constraints.

## AzerothCore

- Commit: `3cafaf4a588fd1f287678fdb37438fdedd1ed85c` (master, 2026-08-20)
- Where: git submodule at `deps/azerothcore`; the submodule pointer in our history is the authoritative pin, this file is the human-readable record.
- Why this commit: latest master at project start (2026-08-21). Master is the supported branch for 3.3.5a; there is no meaningful stable tag cadence to prefer.
- Bumping: update the submodule, rebuild the worldserver image, rerun the smoke script, update this file in the same commit.

## Bun

- Version: 1.4.0, pinned in `.bun-version`, `package.json` (`engines.bun`) and the `oven/bun` image tags in `infra/compose.yml`.
- Patch bumps are deliberate; the pin rationale is in CLAUDE.md's toolchain section.

## Server data directory (not in repo)

- AzerothCore 3.3.5a data (`dbc/ maps/ vmaps/ mmaps/`) matching the pinned core, supplied by the operator at `data/client`; never committed. See `docs/DATA-AND-LEGAL.md`.
