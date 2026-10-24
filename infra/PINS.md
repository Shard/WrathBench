# Pinned versions

Pins are changed deliberately and documented here with a date and reason. See CLAUDE.md hard constraints.

## AzerothCore

- Commit: `3cafaf4a588fd1f287678fdb37438fdedd1ed85c` (master, 2026-08-20)
- Where: git submodule at `deps/azerothcore`; the submodule pointer in our history is the authoritative pin, this file is the human-readable record.
- Why this commit: latest master at project start. Master is the supported branch for 3.3.5a; there is no meaningful stable tag cadence to prefer.
- Bumping: update the submodule, rebuild the worldserver image, rerun the smoke script, update this file in the same commit.

## Bun

- Version: 1.4.4 (2026-10-24, from 1.4.0; the latest release, operator's call), pinned in `.bun-version`, `package.json` (`engines.bun`, and `@types/bun` at the same version), the `FROM oven/bun` tag in `infra/docker/runner.Dockerfile` and the `oven/bun` image tags in `infra/compose.yml`. Tags only, no digests, as for every base image here. CI and the web-session hook read `.bun-version`.
- Patch bumps are deliberate; the pin rationale is in CLAUDE.md's toolchain section.
- Bumping: change every place above in one commit, regenerate `bun.lock` with the new Bun, run `bun run test` and `bun run typecheck` under it, and build the runner image. Two effects reach past the checkout. The minimap transcoder's encoder id names the Bun build (`minimap/src/transcode.ts`), so the next transcode re-encodes every served tile; the tile publish skips by content hash, so only tiles whose bytes the new encoder changed upload again. And the module's `/events` socket is only exercised against the live stack, so run the smokes after a bump that touches WebSocket behaviour (1.4.4 changed the client's close codes and close timing).

## ClickHouse

- Image: `clickhouse/clickhouse-server:25.8`, pinned in `infra/compose.yml` and
  in the chart's `clickhouse.image` value.
- Why this tag: the current LTS line when the derived store landed. A
  major-version bump changes merge and codec behaviour, so it is
  a deliberate change, not a floating tag.
- Bumping: change both places in one commit, bring the new image up against a
  throwaway volume, apply `collector/schema.sql`, replay a run and check the row
  counts back. Nothing here is the only copy of anything — the store is rebuilt
  from `data/runs` by `bun collector/src/main.ts --replay` — so the fallback for
  a bad bump is to drop the volume and backfill.

## Server data directory (not in repo)

- AzerothCore 3.3.5a data (`dbc/ maps/ vmaps/ mmaps/`) matching the pinned core, supplied by the operator at `data/client`; never committed. See `docs/DATA-AND-LEGAL.md`.
