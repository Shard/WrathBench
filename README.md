# WrathBench

**An agent workbench for World of Warcraft.**

WrathBench evaluates AI agents on their ability to play World of Warcraft: Wrath of the Lich King through a TypeScript SDK on a private AzerothCore server. A model writes and supervises code that drives one character in a live game world. Watching an agent observe, decide and act over hours of play, levelling and questing its way out into the world, gives perspective on its long-horizon planning, memory and problem solving capabilities.

The long-term goals for the project include, all using fresh level-1 characters with no direction:
- An agent reaching the level cap in freeplay
- A group of agents form a group and enter and completes a dungeon together.
- A raid of agents clears Icecrown Citadel
- Community agents can join a shared server over the same protocol.

The pieces that make up WrathBench include:
- A thin AzerothCore server module that exposes what a game client could see and do
- A TypeScript SDK
- A runner harness that gives a model the SDK in a sandbox and logs everything
- A Dashboard that is also the public site at <https://wrathbench.shard.page>.
- Other tools for setting up your own harness and running WrathBench either via Docker Compose or Helm Chart (Kubernetes).

## Running it
You will need Docker with compose, Bun for the host-side tooling, and an [AzerothCore](https://www.azerothcore.org/) 3.3.5a server data directory (`dbc/ maps/ vmaps/ mmaps/`) at `data/client`. Producing that directory is outside this repository's scope. Nothing Blizzard-derived is hosted within this repo.

```sh
git clone --recurse-submodules git@github.com:Shard/WrathBench.git && cd wrathbench
mkdir -p data/{client,wiki,runs,etc,logs}
# place the server data directory at data/client
docker compose -f infra/compose.yml up -d --build
```

The first start compiles AzerothCore with the module and imports the databases. Once the worldserver is up, check the control surface end to end, then run an episode with model keys in `.env`:

```sh
docker compose -f infra/compose.yml exec runner bun infra/smoke/module-slice.ts
./infra/run-episode.sh --model <provider/model-id> --driver openai \
  --api-base <openai-compatible base url> --api-key-env <ENV_KEY_NAME>
```

Trajectories land under `data/runs/<run-id>/`. The service graph and the operator's runbook are `infra/README.md` and `docs/RUNBOOK.md`.

## Developing without game data

The harness itself needs none of the above. From a bare clone, `bun install` at the root (Bun is pinned in `.bun-version`), then:

```sh
bun test                     # every workspace, all fixture-based
bun run typecheck
bun run dashboard:build
bun run viewer               # serves the dashboard with empty states
```

The worldserver, the smoke scripts, the wiki reference bundle and the minimap tiles all need operator-supplied data and stay out of reach without it; the module compiles only inside the worldserver image.

## Licence

`module/` is GPL-2.0-or-later under `module/LICENSE`. Everything else original to WrathBench is MIT under the root `LICENSE`. Neither relicenses AzerothCore, Blizzard's assets or any dependency; see `THIRD-PARTY-NOTICES.md` and `docs/DATA-AND-LEGAL.md`. Contributions and vulnerability reports: `CONTRIBUTING.md` and `SECURITY.md`.
