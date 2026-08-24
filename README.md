# WrathBench (working name)

An LLM evaluation harness built on World of Warcraft 3.3.5a via AzerothCore. A model drives a character through a versioned TypeScript SDK; the game server is the source of truth for what happened.

Status: Phase 0, pre-alpha. Private repository. See `docs/PHASE-0.md`.

## Documents

- `CLAUDE.md`: working instructions for agents and contributors
- `docs/VISION.md`: what this is, what it measures, what it is not
- `docs/ARCHITECTURE.md`: components and data flow
- `docs/CONTRACTS.md`: what the agent may observe and do
- `docs/PHASE-0.md`: current scope, task list, and the gate
- `docs/DATA-AND-LEGAL.md`: data handling posture
- `docs/WORKLOG.md`: index of the per-day worklogs in `docs/worklogs/` — what shipped and what broke, with commits
- `docs/decisions/`: architecture decision records

## Quick start

You need Docker with compose, Bun (only for host-side tooling), an
AzerothCore 3.3.5a server data directory (`dbc/ maps/ vmaps/ mmaps/`) placed
at `data/client`, and a wiki dump if you want the reference tool. Producing
the server data directory is outside this repository's scope; AzerothCore's
own documentation covers it. Nothing Blizzard-derived is in this repository;
it all lives under `data/`, which is gitignored.

```sh
git clone --recurse-submodules <this repo> && cd wrathbench
mkdir -p data/{client,wiki,runs,etc,logs}

# place an AzerothCore server data directory (dbc/ maps/ vmaps/ mmaps/) at data/client

docker compose -f infra/compose.yml up -d --build   # first build compiles AzerothCore (+ the module)
```

The first `up` imports the AzerothCore databases (minutes). When
`docker compose -f infra/compose.yml ps` shows worldserver up, verify the
control surface end to end:

```sh
docker compose -f infra/compose.yml exec runner bun infra/smoke/module-slice.ts
```

Then run an episode (put model API keys in `.env` first — see
`infra/run-episode.sh --help`):

```sh
./infra/run-episode.sh --model <provider/model-id> --driver openai \
  --api-base <openai-compatible base url> --api-key-env <ENV_KEY_NAME>
```

Trajectories land under `data/runs/<run-id>/`. Details, uid caveats, and the
service graph: `infra/README.md`.

## Developing without game data

Harness development needs none of the above. From a bare clone with no `data/`
directory: `bun install` once at the root (Bun 1.4.0, pinned in
`.bun-version` — an older Bun rejects the lockfile), then

```sh
bun test                     # every workspace's suite; all fixture-based
bunx tsc --noEmit -p <dir>   # sdk, runner, wiki, minimap, dashboard, infra
bun run docs:api:check       # the generated SDK reference is in sync
bun run dashboard:build      # the SPA, no data involved
bun run viewer               # serves labelled empty states; creates data/runs
```

What stays out of reach without operator-supplied data — by design, since
nothing Blizzard-derived may enter git (`docs/DATA-AND-LEGAL.md`):

- the worldserver, and with it every smoke script in `infra/smoke/` and any
  live episode — needs `data/client` plus the AzerothCore submodule and a
  Docker build;
- the wiki reference bundle — built from a local dump under `data/wiki`;
  absent, `search_reference` reports itself unavailable and runs proceed
  without it;
- minimap tiles — extracted from a licensed client's archives; the map view
  draws labelled grid squares instead;
- `module/` — compiles only inside the worldserver image; its verification is
  the smoke scripts, which need the live stack.

## Licence

`module/` is GPL-2.0-or-later; see `module/LICENSE`. All other original WrathBench code and documentation, including `sdk/`, `runner/`, `dashboard/`, `wiki/`, `minimap/`, `infra/`, and `docs/`, are MIT under the root `LICENSE`. This boundary does not relicense AzerothCore itself, Blizzard assets, or third-party dependencies; see `THIRD-PARTY-NOTICES.md` and `docs/DATA-AND-LEGAL.md`.
