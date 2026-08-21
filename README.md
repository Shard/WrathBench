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
- `docs/decisions/`: architecture decision records

## Quick start

You need Docker with compose, Bun (only for host-side tooling), a local WoW
3.3.5a client for the one-time data extraction, and a wiki dump if you want
the reference tool. Nothing Blizzard-derived is in this repository; it all
lives under `data/`, which is gitignored.

```sh
git clone --recurse-submodules <this repo> && cd wrathbench
mkdir -p data/{client,wiki,runs,etc,logs}

# one-time: extract dbc/maps/vmaps/mmaps from your client (~13 min)
[removed]=/path/to/your/3.3.5a-client ./infra/[removed]

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

Trajectories land under `data/runs/<run-id>/`. To watch the world yourself
with a game client, see `infra/[removed]` and `infra/[removed]`. Details,
uid caveats, and the service graph: `infra/README.md`; extraction:
`infra/[removed]`.

## Licence

`module/` is AGPL-3.0 (it is an AzerothCore module). `sdk/`, `runner/`, `wiki/`, and `infra/` are MIT. No Blizzard-owned material is included or distributed; see `docs/DATA-AND-LEGAL.md`.
