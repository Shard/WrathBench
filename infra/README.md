# infra

Everything runs in containers from `infra/compose.yml`. The only host-side
prerequisite is an AzerothCore server data directory at `data/client`.

## Bringing the stack up

From the repository root, on a fresh machine:

```
mkdir -p data/{client,wiki,runs,etc,logs}
# place an AzerothCore server data directory (dbc/ maps/ vmaps/ mmaps/) at data/client
docker compose -f infra/compose.yml up -d
```

The `mkdir` is not optional. The server containers run as uid 1000 and Docker
creates a missing bind-mount source as root, so without it the AzerothCore
entrypoint's write test on `env/dist/etc` and `env/dist/logs` fails and the
servers refuse to start usefully. If your uid is not 1000, set `WRATHBENCH_UID`
and `WRATHBENCH_GID` before building.

The first `up` takes a while: `db-import` populates three databases from the
AzerothCore SQL dumps.

## Services

```
db  ──healthy──>  db-import  ──completed──>  bootstrap  ──completed──>  authserver
                                                        └────────────>  worldserver  ──>  runner
```

- **db** — MySQL 8.4, the version AzerothCore's own compose pins. Data in the
  named volume `db-data`. Never published to the host.
- **db-import** — one shot. Runs AzerothCore's `dbimport`, which creates
  `acore_auth`, `acore_characters` and `acore_world` if they are missing,
  imports the base dumps, and applies pending updates. Exits 0 when done, so
  it is a no-op on subsequent boots.
- **bootstrap** — one shot. See below.
- **authserver** / **worldserver** — AzerothCore, built from
  `infra/docker/server.Dockerfile` with `module/` compiled in.
- **runner** — a long-lived `sleep infinity` container that everything else is
  `exec`'d into: the smoke scripts, one-off episodes, the viewer. It carries the
  repo and the `data/` mounts, not a loop of its own.
- **fixtures** — one-off operator tool, behind the `tools` profile. Puts a
  logged-out smoke character into a named scenario. See "Scenario fixtures".
- **fleet** — the fleet supervisor (`infra/run-fleet.ts`) as a long-lived
  service, same image and mounts as `runner`. Behind the `fleet` compose profile
  so it only starts when named. See `docs/OPERATIONS.md` ("Running the fleet as
  a service").
- **publisher** — pushes the public dashboard's JSON to object storage on a
  timer (`infra/publish-dashboard.ts --loop`), behind the `publish` profile.
  See `docs/PUBLIC-DASHBOARD.md`. Minimap tiles are not part of that loop:
  `infra/publish-tiles.ts --dry-run | --upload` is a separate, hand-run step
  that uploads `data/minimap` to the same bucket under `tiles/`, skipping by
  content hash, and it is the only thing that ever puts a tile there.

Per `docs/DATA-AND-LEGAL.md` there is no public play endpoint. The only ports
published to the host are 3724 (authserver) and 8085 (worldserver), bound
explicitly to `127.0.0.1` for operator inspection. Nothing may ever bind
beyond loopback. Any other port needed for debugging follows the same rule
and is not committed.

## Configuration

AzerothCore reads an `AC_*` environment variable in preference to the matching
key in `worldserver.conf` / `authserver.conf`: `ConfigMgr::GetValueDefault`
checks the environment first and only falls back to the parsed file. So the
`.conf` files generated under `data/etc` on first boot are the stock dist files
and every setting we care about — DataDir, database DSNs, realm id, XP rates —
is set in `compose.yml` instead. Editing `data/etc/*.conf` will *not* override
what compose sets; change compose.

## Bootstrap

`infra/bootstrap/bootstrap.ts` runs on Bun between `db-import` and the servers.
It does two things, idempotently:

1. Upserts the `auth.realmlist` row for realm 1, pointing `address` and
   `localAddress` at the `worldserver` compose hostname on port 8085 with
   gamebuild 12340, and deletes any other realm row.
2. Ensures an account (`RUNNER` / `RUNNER` by default) exists with the
   configured password, computing the SRP6 salt and verifier the same way
   `AccountMgr::CreateAccount` does and writing them into the `binary(32)`
   columns via `UNHEX()`. It reads the row back and recomputes the verifier
   from the stored salt as a round-trip check.

The smoke probes that hold a session for minutes (`infra/smoke/module-quest.ts`)
use a second account `PROBE` so they never contend with `RUNNER` for the
one-live-session-per-account limit. On a fresh machine create it once with:

    docker compose -f infra/compose.yml run --rm \
      -e WRATHBENCH_ACCOUNT_USER=PROBE -e WRATHBENCH_ACCOUNT_PASSWORD=PROBE \
      bootstrap

Every extra account is made the same way — `SHAKEOUT`, `RUNNER2`, `SHAKEOUT2`.
It is a pure auth-database write, so it is safe on a running server (add
`--no-deps` to keep `compose run` from touching `db-import`), but the account is
not usable by the module until it is in `AC_WRATH_BENCH_ACCOUNTS`, which is read
when the worldserver container is created.


It writes SQL directly rather than using SOAP or the worldserver console. SOAP
cannot create the *first* account — `ACSoap.cpp` requires the caller to be
`SEC_ADMINISTRATOR` and the base auth schema seeds no accounts at all — and it
would mean enabling a privileged control path into the world, which the harness
deliberately does not have. The console (`docker compose attach worldserver`,
then `account create ...`, which is what AzerothCore's docker README tells you
to do by hand) is interactive, races the world load, and is not idempotent.
The cost of direct SQL is a small reimplementation of SRP6, pinned to
`src/common/Cryptography/Authentication/SRP6.cpp`; if AzerothCore changes that
derivation, logins fail at the authserver and `bootstrap.ts` is where to look.

The runner account is an ordinary player with no `account_access` row. The
agent gets no GM privileges by contract (`docs/CONTRACTS.md`). A GM operator
account for inspecting the world is created by `infra/spectator-account.ts`.

Override the defaults with `WRATHBENCH_ACCOUNT_USER`,
`WRATHBENCH_ACCOUNT_PASSWORD`, `WRATHBENCH_REALM_NAME`, and
`WRATHBENCH_DB_ROOT_PASSWORD` in the environment or a local `.env`. Usernames
and passwords are uppercased before hashing, as AzerothCore does; use uppercase
values to keep that a non-question.

## Scenario fixtures

`infra/fixtures/` puts a **logged-out smoke character** into a named scenario —
level, money, position, homebind, spells, quest log — so a smoke can prove a
late-game claim in seconds instead of playing the minutes it would take to walk
there. The fast gate otherwise only ever sees what a level-1 character can
reach from the Northshire spawn.

    docker compose -f infra/compose.yml run --rm --no-deps fixtures \
      --account SMOKE3 --character Smoketram --scenario tram-ironforge

    # or, inside a container that can already reach the db:
    bun infra/fixtures/apply.ts --account SMOKE3 --character Smoketram \
      --scenario tram-ironforge [--wait-ms 90000] [--dry-run]

`--dry-run` prints the statements it would run and touches nothing. The
scenarios live in `infra/fixtures/scenarios.ts`; today they are
`tram-ironforge` (level 10, 1g, standing at the Deeprun Tram portal facing the
areatrigger), `trainer-northshire` (level 4, 50s, in front of Brother Sammuel),
`northshire-fresh` (a reset to the level-1 human start with an empty quest log)
and `vineyard-kill-credit` (level 1 at the Northshire vineyard edge with
"Kobold Camp Cleanup" already in the log). Adding one is a data edit in that
file.

The preflight gate uses fixtures too: `kill-credit.ts` starts from
`vineyard-kill-credit` instead of playing the 783 turn-in that gates the kill
quest, which is why the `fleet` service carries the same `WRATHBENCH_DB_*` env
as `fixtures` — and so does `runner`, where the smokes are exec'd by hand, so

    docker compose -f infra/compose.yml exec runner bun infra/smoke/kill-credit.ts

needs no `-e` flags at all. A benchmark episode cannot pass those credentials
on: `sandboxChildEnv` in `runner/src/sandbox/host.ts` drops every
`WRATHBENCH_DB_*` var from the snippet child's environment, on both services.

This is **operator tooling**. Nothing in `runner/` or `sdk/` imports it, so the
agent-facing contract in `docs/CONTRACTS.md` is untouched: the agent still only
observes what a client could observe and still only acts through the module. A
fixture is the operator arranging the world before a run, the same way the
operator picks which account a smoke logs into.

**Why direct SQL.** The same reason as bootstrap above: the harness has no
privileged control path into the running world. SOAP is off by contract and the
worldserver console is interactive and racy. Setting up a *character* has the
extra constraint that it must never be something the agent can reach, which is
why it lives in `infra/` and refuses any account not matching
`^(SMOKE\d*|PROBE)$`. Runner and shakeout accounts are never fixtured — a
benchmark run must start from a character the agent itself created.

**The `online = 0` wait.** The core reads the `characters` row on login and
writes it back on logout, so a fixture applied under a live session is simply
overwritten by that session's save. The tool polls `characters.online` every
500ms (up to `--wait-ms`, default 90s) and only writes once it reads 0.
`online = 0` is written by the logout `SaveToDB`, so it is the signal that the
*late save has landed*, not merely that the session was asked to end — the
module's `DELETE /session` acknowledges as soon as the logout is queued, and
`LogoutPlayer` runs on a later world tick (with the core's own logout timer in
front of it).

**No items.** `item_instance` guids come from an in-memory sequence generator
seeded once at worldserver boot from `SELECT MAX(guid) FROM item_instance`, so
rows written from outside a running server collide with guids the server is
handing out — and the next boot *deletes* everything at or above its own
watermark (`ObjectMgr.cpp` runs one-time DELETEs against `character_inventory`,
`mail_items`, `auctionhouse`, `guild_bank_item`). Gear a smoke needs has to
come through the module: a vendor purchase, a quest reward. `at_login` is left
alone for the same "leave the core's own flags to the core" reason.

The `fixtures` compose service sits behind the `tools` profile so a bare `up`
never starts it, and its flags come after an `entrypoint` (not a `command`), so
`compose run fixtures --account ...` appends rather than clobbers. `--no-deps`
keeps compose from deciding `db-import` needs a rerun against a live stack.

## Rosters

`infra/run-roster.sh <roster.json>` runs a list of episodes one at a time
through `run-episode.sh`. The roster JSON is a plain array; every entry is
config and everything but `model` has a default, so an old bare
`[{ "model": ... }]` roster still produces exactly the argv it always did:

| key | default | notes |
| --- | --- | --- |
| `model` | — | required, passed through verbatim |
| `driver` | `openai` | or `claude-code` (the claude-code harness; the former spelling `claude-subscription` is refused, not translated) |
| `account` | runner default (`RUNNER`) | one live session per account |
| `effort` | unset | reasoning effort. `openai` sends it as `reasoning_effort`; `claude-code` as the CLI's `--effort` (`low\|medium\|high\|xhigh\|max`). Unset means the provider's own default, which is not the same as any named level — and it becomes part of the derived run id, so `opus` and `opus@low` are two runs |
| `apiBase`, `apiKeyEnv` | OpenRouter, `OPENROUTER_KEY` | `openai` entries only; a claude entry gets neither flag |
| `race`, `class` | Human Paladin | no name: the model names its own character at `createSession` and the run records what it chose |
| `episodeMs` | 5400000 (90m) | |
| `runId` | `roster-<model-slug>-<date>` | |

`--loop` restarts the roster when the list is exhausted, until `--until` or
`--max-hours` (one of which it requires). Cycle 2 onward gets `-cN` run ids;
since a fresh episode wipes the account's characters first, every cycle starts
at level 1 whatever the model names its new one. Loop mode burns tokens, it does not build
a levelling curve.

Before each launch the roster checks whether another run already holds the
entry's account — no termination row and a write in the last few minutes — and
waits (polling, giving up after 30 minutes) rather than launching into
`account_in_use`. This applies to old rosters too: an entry without `account`
is guarded on `RUNNER`, so it now waits behind a live hand-started run there
where before it launched and failed in seconds. It
only ever *frees* its own session (`DELETE /session` is keyed on
`token == runId`); another process's session is never touched.

Two rosters ship for the subscription driver:

- `roster-claude.json` — opus and sonnet alternating on `SHAKEOUT`, 90m each.
  Runnable today: `./infra/run-roster.sh infra/roster-claude.json --loop --until 07:30`.
- `roster-claude-2wide.json` — opus on `SHAKEOUT`, sonnet on `SHAKEOUT2`, for
  running both at the same time. **Not runnable until the worldserver
  is next recreated**: the account exists in auth, but `SHAKEOUT2` only enters
  the module's `AC_WRATH_BENCH_ACCOUNTS` allowlist on container recreate, and
  until then every createSession on it answers 403 `account_not_permitted`.

The roster runs its entries sequentially by design. Two streams in parallel means
two roster processes, one per JSON, each with its own account and its own
`--log` path so the two JSONLs do not interleave. **Superseded by the fleet**
(next section) — hand-launching parallel rosters with `--skip` and `&` still
works, but the fleet is the supported way to run more than one stream. If you do
launch by hand, do not run `roster-claude.json` and `roster-claude-2wide.json`
on the same day at the same time: both derive their run ids from the model name
(`roster-opus-<date>`), so the two opus entries would be the same run. Fleet
run ids carry the job name (`fleet-<job>-...`), which is how the fleet
sidesteps that collision.

## The fleet

`infra/fleet.json` is the whole answer to "what is running right now". Its
unit of work is the **job**: a roster entry (or a rotation of
several), an episode tier, a repeat count, run as one `run-roster` process on
one game **account**. Accounts have a **class** — `pool`, `paid`, `local`, or
pinned to one job — and the class decides which job may land on them. A job
that names an `account` is pinned to it; a job without one is pool work; and
the scheduling policy makes up jobs of its own for whatever the manual queue
leaves free. Inspect the config, and you have inspected the fleet.

    ./infra/run-fleet.sh infra/fleet.json --until 18:00   # run it
    ./infra/run-fleet.sh infra/fleet.json --dry-run       # print the plan
    ./infra/run-fleet.sh --status                         # read-only report

The file has a `roster` map — the model **catalog**: name → the per-entry
schema the roster accepts, plus `tier` and `idle`, and never an `objective`
(steering belongs to a campaign) — an `accounts` block (`pool`, `paid`, `local` lists), a
`campaigns` map (probe campaigns: an objective swept over `cells` by a set of
`models`, optionally pinned to an `account`), a `queue` of jobs (`ref`,
`episode`, `repeat`, optional `account`, optional `enabled`), a `policy` block
and a `preflight` block. A job's name is always `<first ref>-<episode>`, or
`<campaign>-<cell>` for a pinned campaign. The fleet
spawns one `run-roster` process per job it places — materialized roster at
`data/runs/fleet-<job>-<date>.roster.json`, roster JSONL at
`fleet-<job>-<date>.jsonl`, stdout at `fleet-<job>-<date>.log` — and
supervises them. There is no other shape: a file that still says `lanes` or
`accounts.pinned` is refused by name.

**The tuning knob is the file.** The supervisor re-reads `fleet.json` every
60 seconds:

- `enabled: false` **drains** the job: the roster process is only SIGTERMed
  once it is between episodes (no child process), so the episode in flight
  finishes. Worst case — an episode spawning in the instant between the idle
  check and the signal — gets run-roster's own graceful 30s-grace episode
  termination, never a hard kill. Disable takes effect at the next episode
  boundary.
- `enabled: true`, or a newly added job, spawns on the next tick. A job
  respawned the same day gets `--resume-roster` so finished runs are skipped.
- A malformed or guard-violating edit never touches running jobs: the fleet
  logs a complaint and keeps the last good config.
- A job whose process exits while enabled is *finished*, not respawned; flip
  it off and on again to re-arm it.

Guards, at startup and on every re-read: two enabled jobs must not share an
account (one live session per account), and the **roster policy** — claude
models (`opus`/`sonnet`/`haiku`/`claude-*`) run only via the
`claude-code` driver, and that driver runs claude models only. The
free entries exist because OpenRouter's and OpenCode Zen's free tiers are
pooled per upstream provider: a single sequential stream per pool is both the
polite and the effective shape — two streams on one pool just trip the same
rate limits twice. So an openai entry on a **shared free-cloud pool**
(`openrouter.ai` / `opencode.ai`, or no `apiBase` at all, which defaults to
OpenRouter) must carry free model ids only — ending `-free` or `:free` — unless
it declares `billing: "paid"` on purpose. The roster's own account-busy guard
still runs under every job, so a job pointed at an account a hand-started run
holds waits rather than clobbering.

### Local (self-hosted) models

An openai entry may point `apiBase` at a self-hosted OpenAI-compatible endpoint
instead of a cloud pool — the shipped `qwen3-8-27b` entry targets an LM Studio
box on the LAN (`http://192.168.1.20:1234/v1`, model `qwen/qwen3.8-27b`). A
local apiBase is a distinct category in the roster policy, and its runs land
only on the `local` account class:

- **Exempt from the free-suffix rule.** There is no shared free tier to meter,
  so the model id need not end `-free`/`:free`. The guard treats any apiBase
  that is not an `openrouter.ai`/`opencode.ai` host as local.
- **Still claude-barred.** No `claude-*` id ever rides an openai entry, local or
  cloud; claude runs only on the `claude-code` driver.
- **`apiKeyEnv` names a dummy key.** LM Studio ignores the bearer value, but the
  pipeline needs the env var to exist, so `.env` carries a non-secret
  `LMSTUDIO_KEY=lm-studio` placeholder. Delivery mirrors the cloud entries
  exactly: the key travels only in `.env` (Bun autoloads `/wrathbench/.env`
  inside the runner container), never through argv. The adapter still sends its
  attribution headers unconditionally; a local server just ignores them.

Before adding a local model, prove the endpoint can drive the tool loop:

    bun infra/smoke/local-model.ts

It hits the endpoint directly with one tool definition and no `tool_choice`
(mirroring the adapter), and asserts the model *elects* a tool call whose shape
satisfies the adapter's exact contract — `id` a non-empty string, `arguments` a
JSON string. It prints the round-trip latency and `finish_reason`, and reports a
clear no-go if the model answers in prose or returns a shape the adapter would
reject. No game account or module needed.

`--status` reads `data/runs/fleet-state.json` plus each job's logs and
sqlite: the supervisor's heartbeat, the gate's last result, one row per
account with the job on it (run id, level/xp, elapsed, cooling), the models
table with the scheduler's verdict, the paused runs it is not resuming and
why, and — honestly — which run currently holds an account even when that run
is a hand-started roster the fleet does not manage. The dashboard's fleet page
carries the same indicators. A job that ships `enabled: false` is a switch,
not dead config: flip it to true when there is budget to spend on it, flip it
back and the job stops after the episode in flight.

## Where data lives

`data/` is gitignored at the directory level and holds everything
Blizzard-derived or run-specific.

| path | contents | mounted as |
| --- | --- | --- |
| `data/client` | AzerothCore server data `dbc/ maps/ vmaps/ mmaps/` | read-only at `/azerothcore/env/dist/data` in worldserver |
| `data/etc` | generated `.conf` files | `/azerothcore/env/dist/etc` in the servers |
| `data/logs` | server logs | `/azerothcore/env/dist/logs` in the servers |
| `data/wiki` | wiki dump and built bundle | `/wrathbench/data/wiki` in runner |
| `data/runs` | trajectories and run sqlite | `/wrathbench/data/runs` in runner |

The MySQL data directory is the named volume `db-data`, not a bind mount.
`docker compose down` keeps it; `docker compose down -v` throws the world away
and the next `up` re-imports from scratch.

## Verifying without a full boot

```
docker compose -f infra/compose.yml config          # validates
docker compose -f infra/compose.yml up -d db        # goes healthy in ~15s
docker compose -f infra/compose.yml ps              # check status, not a port
docker compose -f infra/compose.yml down            # volumes survive
```

## Pins

See `infra/PINS.md`. The AzerothCore commit is the submodule pointer at
`deps/azerothcore`; the images are built from that tree.
