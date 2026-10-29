# Pinned versions

Pins are changed deliberately and documented here with a date and reason. See CLAUDE.md hard constraints.

## AzerothCore

- Commit: `3cafaf4a588fd1f287678fdb37438fdedd1ed85c` (master, 2026-08-20)
- Where: git submodule at `deps/azerothcore`; the submodule pointer in our history is the authoritative pin, this file is the human-readable record.
- Why this commit: latest master at project start. Master is the supported branch for 3.3.5a; there is no meaningful stable tag cadence to prefer.
- Bumping: update the submodule, rebuild the worldserver image, rerun the smoke script, update this file in the same commit. The pinned wrath-mcp's README states the AzerothCore commit it is tested against, and `bun run boundary` (also a test) fails until the two agree, so a core bump moves with a wrath-mcp change.

## wrath-mcp (the agent stack)

- Commit: `5a8b1a47da1f10bd4657557b6010c7239f079949` (wrath-mcp master, the stack at 0.2.0 with Unreleased fixes: the server's quest, portal and whisper refusals as events the helpers settle on, unit reaction from the client's faction tables, the vendor buyback slots, `use_item`'s glyph slot, `WrathBench.Enable` shipped off, the GM opt-in, off by default, without which the module refuses a GM account and chat the server would run as a command, and the first wave of wrath-mcp issue #4: quest objective areas, class resources, named unit state, stand state, shapeshift form and the character sheet, dismount, opening lootable items, and item and ground targets on a cast; then vehicles and possession, driven by the mover, and a create block's absent fields read as zero, and the module header declaring `Unit` for the mover helpers; then the second wave: a stun told apart from a root, flight on request with `canFly` and `airborne` observed, jump, knockbacks acked and flown, gossip options that take a code, inbound emotes and channel notices, and a possessed unit's or vehicle's bar spells in `pet().spells`).
- Where: git submodule at `wrath-mcp/` (https://github.com/Shard/wrath-mcp); the submodule pointer in our history is the authoritative pin, this file is the human-readable record. It pins the C++ module, the SDK and the MCP stack together: the server image compiles `wrath-mcp/module`, and `wrath-mcp/sdk` and `wrath-mcp/mcp` are workspaces of this repository. Every run stamps the commit in `meta.json` as `stackCommit`, a label beside `sdkVersion`.
- Rules: the pin on master is a commit on wrath-mcp's master (`build-images.sh` refuses anything else for an image that can be pushed, and CI checks it on master); a PR may pin a wrath-mcp branch commit while both are in review. Merge order is wrath-mcp first, then the bump here. The Bun, zod, typescript and `@types/bun` pins agree across the two repositories (`bun run boundary`).
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
