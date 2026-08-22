# infra

Everything runs in containers from `infra/compose.yml`. Host-side work is
limited to the one-time client data extraction.

## Bringing the stack up

From the repository root, on a fresh machine:

```
mkdir -p data/{client,wiki,runs,etc,logs}
./infra/[removed]   # once, needs a local 3.3.5a client; see [removed]
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
- **runner** — placeholder today (`sleep infinity`). Becomes the agent loop.
- **fleet** — the fleet supervisor (`infra/run-fleet.ts`) as a long-lived
  service, same image and mounts as `runner`. Behind the `fleet` compose profile
  so it only starts when named. See `docs/OPERATIONS.md` ("Running the fleet as
  a service") and ADR-0020.

Per `docs/DATA-AND-LEGAL.md` there is no public play endpoint. The only ports
published to the host are 3724 (authserver) and 8085 (worldserver), bound
explicitly to `127.0.0.1` so the operator's own client can log in and spectate
— see `[removed]`. Nothing may ever bind beyond loopback. Any other port
needed for debugging follows the same rule and is not committed.

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
agent gets no GM privileges by contract (`docs/CONTRACTS.md`). For a GM
operator account to spectate the world with your own client, use
`infra/spectator-account.ts` — see `[removed]`.

Override the defaults with `WRATHBENCH_ACCOUNT_USER`,
`WRATHBENCH_ACCOUNT_PASSWORD`, `WRATHBENCH_REALM_NAME`, and
`WRATHBENCH_DB_ROOT_PASSWORD` in the environment or a local `.env`. Usernames
and passwords are uppercased before hashing, as AzerothCore does; use uppercase
values to keep that a non-question.

## Rosters

`infra/run-roster.sh <roster.json>` runs a list of episodes one at a time
through `run-episode.sh`. The roster JSON is a plain array; every entry is
config and everything but `model` has a default, so an old bare
`[{ "model": ... }]` roster still produces exactly the argv it always did:

| key | default | notes |
| --- | --- | --- |
| `model` | — | required, passed through verbatim |
| `driver` | `openai` | or `claude-subscription` (SHAKEOUT lane only) |
| `account` | runner default (`RUNNER`) | one live session per account |
| `effort` | unset | reasoning effort. `openai` sends it as `reasoning_effort`; `claude-subscription` as the CLI's `--effort` (`low\|medium\|high\|xhigh\|max`). Unset means the provider's own default, which is not the same as any named level — and it becomes part of the derived run id, so `opus` and `opus@low` are two runs |
| `apiBase`, `apiKeyEnv` | OpenRouter, `OPENROUTER_KEY` | `openai` entries only; a claude entry gets neither flag |
| `character`, `race`, `class` | derived from the model, Human Paladin | |
| `episodeMs` | 5400000 (90m) | |
| `runId` | `roster-<model-slug>-<date>` | |

`--loop` restarts the roster when the list is exhausted, until `--until` or
`--max-hours` (one of which it requires). Cycle 2 onward gets `-cN` run ids;
characters are reused, and since a fresh episode wipes the account's characters
first, every cycle starts at level 1. Loop mode burns tokens, it does not build
a levelling curve.

Before each launch the roster checks whether another run already holds the
entry's account — no termination row and a write in the last few minutes — and
waits (polling, giving up after 30 minutes) rather than launching into
`account_in_use`. This applies to old rosters too: an entry without `account`
is guarded on `RUNNER`, so it now waits behind a live hand-started run there
where before it launched and failed in seconds. It
only ever *frees* its own session (`DELETE /session` is keyed on
`token == runId`); another process's session is never touched.

Two rosters ship for the subscription lane:

- `roster-claude.json` — opus and sonnet alternating on `SHAKEOUT`, 90m each.
  Runnable today: `./infra/run-roster.sh infra/roster-claude.json --loop --until 07:30`.
- `roster-claude-2wide.json` — opus on `SHAKEOUT`, sonnet on `SHAKEOUT2`, for
  running the two lanes at the same time. **Not runnable until the worldserver
  is next recreated**: the account exists in auth, but `SHAKEOUT2` only enters
  the module's `AC_WRATH_BENCH_ACCOUNTS` allowlist on container recreate, and
  until then every createSession on it answers 403 `account_not_permitted`.

The roster runs its entries sequentially by design. Two lanes in parallel means
two roster processes, one per JSON, each with its own account and its own
`--log` path so the two JSONLs do not interleave. **Superseded by the fleet**
(next section) — hand-launching parallel rosters with `--skip` and `&` still
works, but the fleet is the supported way to run more than one lane. If you do
launch by hand, do not run `roster-claude.json` and `roster-claude-2wide.json`
on the same day at the same time: both derive their run ids from the model name
(`roster-opus-<date>`), so the two opus entries would be the same run. Fleet
run ids carry the lane name (`fleet-<lane>-...`), which is how the fleet
sidesteps that collision.

## The fleet

`infra/fleet.json` is the whole answer to "what is running right now": a list
of **lanes**, where one lane = one sequential episode stream = one game
account, and parallelism is exactly the number of enabled lanes. Inspect the
config, and you have inspected the fleet.

    ./infra/run-fleet.sh infra/fleet.json --until 18:00   # run it
    ./infra/run-fleet.sh infra/fleet.json --dry-run       # print the plan
    ./infra/run-fleet.sh --status                         # read-only report

Each lane has `name`, `enabled`, `account`, `loop`, an optional
`untilDefault` (used when no `--until` is passed), and either inline
`entries` (the exact per-entry schema the roster accepts) or a `rosterFile`
path. The fleet spawns one `run-roster` process per enabled lane —
materialized roster at `data/runs/fleet-<lane>-<date>.roster.json`, roster
JSONL at `fleet-<lane>-<date>.jsonl`, stdout at `fleet-<lane>-<date>.log` —
and supervises them.

**The tuning knob is the file.** The supervisor re-reads `fleet.json` every
60 seconds:

- `enabled: false` **drains** the lane: the roster process is only SIGTERMed
  once it is between episodes (no child process), so the episode in flight
  finishes. Worst case — an episode spawning in the instant between the idle
  check and the signal — gets run-roster's own graceful 30s-grace episode
  termination, never a hard kill. Disable takes effect at the next episode
  boundary.
- `enabled: true`, or a newly added lane, spawns on the next tick. A lane
  respawned the same day gets `--resume-roster` so finished runs are skipped.
- A malformed or guard-violating edit never touches running lanes: the fleet
  logs a complaint and keeps the last good config.
- A lane whose process exits while enabled is *finished*, not respawned; flip
  it off and on again to re-arm it.

Guards, at startup and on every re-read: two enabled lanes must not share an
account (one live session per account), and the **lane policy** — claude
models (`opus`/`sonnet`/`haiku`/`claude-*`) run only via the
`claude-subscription` driver, and that driver runs claude models only. The
free lanes exist because OpenRouter's and OpenCode Zen's free tiers are
pooled per upstream provider: a single sequential stream per pool is both the
polite and the effective shape — two streams on one pool just trip the same
rate limits twice. So an openai lane on a **shared free-cloud pool**
(`openrouter.ai` / `opencode.ai`, or no `apiBase` at all, which defaults to
OpenRouter) must carry free model ids only — ending `-free` or `:free`. The
roster's own account-busy guard still runs under every lane, so a lane pointed
at an account a hand-started run holds waits rather than clobbering.

### Local (self-hosted) lanes

An openai lane may point `apiBase` at a self-hosted OpenAI-compatible endpoint
instead of a cloud pool — the shipped `local-qwen` lane targets an LM Studio box
on the LAN (`http://192.168.1.20:1234/v1`, model `qwen/qwen3.8-27b`). A local
apiBase is a distinct category in the lane policy:

- **Exempt from the free-suffix rule.** There is no shared free tier to meter,
  so the model id need not end `-free`/`:free`. The guard treats any apiBase
  that is not an `openrouter.ai`/`opencode.ai` host as local.
- **Still claude-barred.** No `claude-*` id ever rides an openai lane, local or
  cloud; claude runs only on the `claude-subscription` driver.
- **`apiKeyEnv` names a dummy key.** LM Studio ignores the bearer value, but the
  pipeline needs the env var to exist, so `.env` carries a non-secret
  `LMSTUDIO_KEY=lm-studio` placeholder. Delivery mirrors the cloud lanes
  exactly: the key travels only in `.env` (Bun autoloads `/wrathbench/.env`
  inside the runner container), never through argv. The adapter still sends its
  attribution headers unconditionally; a local server just ignores them.

Before enabling a local lane, prove the endpoint can drive the tool loop:

    bun infra/smoke/local-model.ts

It hits the endpoint directly with one tool definition and no `tool_choice`
(mirroring the adapter), and asserts the model *elects* a tool call whose shape
satisfies the adapter's exact contract — `id` a non-empty string, `arguments` a
JSON string. It prints the round-trip latency and `finish_reason`, and reports a
clear no-go if the model answers in prose or returns a shape the adapter would
reject. No game account or module needed. `local-qwen` ships `enabled: false`
until `RUNNER6` enters the running module allowlist at the next worldserver
recreate.

`--status` reads `data/runs/fleet-state.json` plus each lane's logs and
sqlite: per lane it prints enabled, roster pid liveness, the current run id
with level/xp, the last stdout line, and — honestly — which run currently
holds the lane's account even when that run is a hand-started roster the
fleet does not manage. `sub-opus` ships `enabled: false` on purpose: it is
the "burn subscription budget" switch. Flip it to true when there is budget
to burn; flip it back and the lane stops after the episode in flight.

## Where data lives

`data/` is gitignored at the directory level and holds everything
Blizzard-derived or run-specific.

| path | contents | mounted as |
| --- | --- | --- |
| `data/client` | extracted `dbc/ maps/ vmaps/ mmaps/ Cameras/` | read-only at `/azerothcore/env/dist/data` in worldserver |
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
