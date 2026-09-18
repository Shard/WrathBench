# WrathBench

An LLM evaluation harness built on World of Warcraft 3.3.5a via AzerothCore. A model drives a character through a versioned TypeScript SDK; the game server is the source of truth for what happened.

Status: pre-alpha — the control surface is built and models reach liftoff in
it. The harness runs under versioned series, currently `harness-0.5`; results
so far are indicative of what a model can do here, not comparable scores — no
single number is promised in this phase (`docs/METHODOLOGY.md`). The public
dashboard is live at <https://wrathbench.shard.page> (`docs/PUBLIC-DASHBOARD.md`).

## In ten lines

A run — an **episode** — hands one model a fresh level-1 character and a fixed
toolkit, and lets it go. The model does not press keys: it writes TypeScript
against a versioned SDK, runs it in a sandbox, reads back events and its own
scratchpad, and decides what to do next. Everything it may see is what a real
3.3.5a client would have received, and every action it takes goes out as the
opcode a client would have sent (`docs/CONTRACTS.md`), so the server — not the
harness — decides what happened.

What that measures is how far a model gets on a long-horizon goal it has to
break down itself, with a toolkit it cannot change. The visible answer is the
**milestone ladder**: eight rungs from "finish the starting quest chain" up to
"clear Icecrown Citadel", each derived from recorded evidence rather than
asserted. A result is only ever a claim within its comparability group — the
episode id it ran under **and** the harness series (`major.minor`) it ran on.
Two runs from different groups are never put on one axis; a run an operator
steered is never scored at all. The reasoning is `docs/METHODOLOGY.md`, the
rulesets are `docs/EPISODES.md`.

It is not a direct-play benchmark and does not claim to be one. Nothing
Blizzard-derived is in this repository (`docs/DATA-AND-LEGAL.md`).

## Reading the dashboard

The same SPA is the public site at <https://wrathbench.shard.page> and the
operator's window (`bun run viewer`, then the SPA). It is one page per grain:

- **`/`** — the explainer, with what is live right now and the e90 ladder.
- **`/runs`** — every recorded run of every kind, one row each, newest first;
  every header sortable and every filter in the URL, so a view is a link.
- **`/about`** — the episode rulesets, how many runs sit against each, and how
  to read a mark (`/episodes` redirects here).
- **`/ladder`** — the aggregate: highest rung reached per model, with the run
  that got there, plus cost against XP earned.
- **`/models`** — the roster and the scheduler's verdict on each entry.
- **`/run/:id`** — one run: its trajectory feed, comparability tuple, tokens and
  cost, and a cumulative-XP chart.
- **`/character/:id`** — a freeplay stream: one character across its attempts.
- **`/fleet`** — what is running right now, and the scheduler's state.
- **`/campaigns`** — the probe campaigns and how far each cell has got.
- **`/map`** — where characters are, live, on minimap tiles.

The harness-series selector in the top bar filters every page that shows runs;
what it dropped is always stated on the page.

## Documents

- `docs/VISION.md`: what this is, what it measures, what it is not
- `docs/METHODOLOGY.md`: the decisions that shape what a result means, and the principles behind them
- `docs/EPISODES.md`: the four rulesets a run can be launched under
- `docs/ARCHITECTURE.md`: components and data flow
- `docs/CONTRACTS.md`: what the agent may observe and do
- `docs/RUNBOOK.md`: running the fleet, deploys, the runbooks
- `docs/COSTS.md`: what a run costs and how that is accounted
- `docs/PUBLIC-DASHBOARD.md`: the push-based public hosting design
- `docs/DATA-AND-LEGAL.md`: data handling posture and the red lines
- `CLAUDE.md`: working instructions for agents and contributors

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
bun run typecheck            # sdk, runner, infra, dashboard, wiki, minimap, collector
bun run docs:api:check       # the generated SDK reference is in sync
bun run dashboard:build      # the SPA, no data involved — build it before the viewer
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

## Contributing and security

Issues and discussion are welcome, pull requests against an agreed issue — `CONTRIBUTING.md` for what holds and why, `SECURITY.md` for reporting a vulnerability.
