# Pinned versions

Pins are changed deliberately and documented here with a date and reason. See CLAUDE.md hard constraints.

## AzerothCore

- Commit: `3cafaf4a588fd1f287678fdb37438fdedd1ed85c` (master, 2026-08-20)
- Where: git submodule at `deps/azerothcore`; the submodule pointer in our history is the authoritative pin, this file is the human-readable record.
- Why this commit: latest master at project start. Master is the supported branch for 3.3.5a; there is no meaningful stable tag cadence to prefer.
- Bumping: update the submodule, rebuild the worldserver image, rerun the smoke script, update this file in the same commit. The pinned wrath-mcp's README states the AzerothCore commit it is tested against, and `bun run boundary` (also a test) fails until the two agree, so a core bump moves with a wrath-mcp change.

## wrath-mcp (the agent stack)

- Commit: `74414c2ec3f3d6b672c5a5bcfcc813588d8f0cc5` (wrath-mcp `v1`: master's 0.2.0 with its Unreleased fixes, as pinned on master at `a22e4fa`, plus phase 1 of the v1 work, the session record: the format `wrath-session/1` with its validator, the session writer, reader and store, the recorders moved out of this repository's runner, tool calls recorded by the dispatcher, recording on by default in the standalone server, and the writer striking the session token from every line; and phase 3's first step, the inspector: `@wrathbench/inspector`, a third workspace here, with its source interface, store source, API, codecs and bin. No module change: the C++ built from this commit is the one built from `a22e4fa`.)
- Where: git submodule at `wrath-mcp/` (https://github.com/Shard/wrath-mcp); the submodule pointer in our history is the authoritative pin, this file is the human-readable record. It pins the C++ module, the SDK and the MCP stack together: the server image compiles `wrath-mcp/module`, and `wrath-mcp/sdk` and `wrath-mcp/mcp` are workspaces of this repository. Every run stamps the commit in `meta.json` as `stackCommit`, a label beside `sdkVersion`.
- Rules: the pin on master is a commit on wrath-mcp's master (`build-images.sh` refuses anything else for an image that can be pushed, and CI checks it on master); a PR may pin a wrath-mcp branch commit while both are in review. Merge order is wrath-mcp first, then the bump here. The Bun, zod, typescript and `@types/bun` pins agree across the two repositories (`bun run boundary`).
- On the `v1` branch: v1 is built on a long-lived `v1` branch in both repositories, so here the pin may be a commit on wrath-mcp's `v1` as well as its master, and `build-images.sh` accepts either. Merge order is unchanged: the stack PR into wrath-mcp's `v1` first, then the bump here. The master rule above is what holds again once v1 merges to master in both.
- Bumping: merge the stack change in wrath-mcp, then move the submodule to the new master commit in a commit of its own, `wrath-mcp: <old>..<new> — <one line>`, which updates the commit above. That commit is the record; a module change is verified only by the release that carries it and `bun wb smoke suite` after it.

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
