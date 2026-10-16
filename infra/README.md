# infra

WrathBench runs in containers, two ways, from the same Dockerfiles and code:

- **On one machine, `infra/compose.yml`.** The quickstart: a way to try
  WrathBench that needs nothing installed beyond Docker, plus an AzerothCore
  server data directory at `data/client`. It is brought up, used and brought
  down. There is no compose deploy or update tooling, because nobody operates
  a compose stack over time.
- **On a cluster, the Helm chart at `infra/chart/wrathbench`.** How the
  project's own fleet runs, and the reference for anyone doing a more serious
  deployment. It is built by `infra/build-images.sh`, released by
  `infra/k8s-release.sh` and operated by `infra/k8s-deploy.sh` ("Releasing on
  Kubernetes", below, and `docs/RUNBOOK.md`).

The operator commands are `bun wb <group> <command>` from the repository root
(`infra/wb.ts`): `bun wb` lists them, and `bun wb <group>` shows the script
each runs. The cluster is the default target, and a command that reads the
data volume runs in the runner pod. `bun wb --local …` targets the quickstart
stack where a command has a compose form.

## Try it on one machine

From the repository root, on a fresh machine:

```
mkdir -p data/{client,wiki,runs,etc,logs,collector,codex}
# place an AzerothCore server data directory (dbc/ maps/ vmaps/ mmaps/) at data/client
echo "WRATHBENCH_MODULE_SECRET=$(openssl rand -hex 32)" >> .env
# add the model key your run will use, e.g. OPENROUTER_KEY=...
docker compose --env-file .env -f infra/compose.yml up -d --build
```

`.env.example` lists every name `.env` may carry. Copy only the lines you set:
Bun reads an empty `NAME=` line as an empty value, not as unset, and an empty
`WRATHBENCH_MODULE_URL` sends a run to no module at all.

The `mkdir` is not optional. The server containers run as uid 1000 and Docker
creates a missing bind-mount source as root, so without it the AzerothCore
entrypoint's write test on `env/dist/etc` and `env/dist/logs` fails and the
servers refuse to start usefully — and the collector, which also runs as 1000,
cannot create its offset database under a root-owned `data/collector`. If your uid is not 1000, set `WRATHBENCH_UID`
and `WRATHBENCH_GID` before building.

`--env-file .env` is how the worldserver gets the module's port secret.
Compose's project directory is `infra/`, so it does not read the repo-root
`.env` on its own; the runner reads the same file through Bun's autoload. Pass
it on every `up`. An `up` without it recreates the worldserver with an empty
secret, and the module refuses to listen until the next `up` that has it. To
stamp the worldserver's `/health` build, export
`WRATHBENCH_BUILD="$(git describe --tags --always --dirty)"` before building;
unstamped, it says `unknown`.

The first `up` takes a while: the AzerothCore build, then `db-import`
populating three databases from the AzerothCore SQL dumps. `docker compose -f
infra/compose.yml down` stops it all and keeps the data ("Where data lives").

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
  so it only starts when named. See `docs/RUNBOOK.md` ("Running the fleet as
  a service").
- **publisher** — pushes the public dashboard's JSON to object storage on a
  timer (`infra/publish-dashboard.ts --loop`), behind the `publish` profile.
  See `docs/PUBLIC-DASHBOARD.md`. Minimap tiles are not part of that loop:
  they are a separate, hand-run upload (`docs/RUNBOOK.md`, "Public
  dashboard").

Per `docs/DATA-AND-LEGAL.md` there is no public play endpoint. Every port
compose publishes is bound explicitly to `127.0.0.1`, for operator inspection:
3724 (authserver), 8085 (worldserver) and 8123 (ClickHouse). Nothing may ever
bind beyond loopback. Any other port needed for debugging follows the same rule
and is not committed.

## Configuration

AzerothCore reads an `AC_*` environment variable in preference to the matching
key in `worldserver.conf` / `authserver.conf`: `ConfigMgr::GetValueDefault`
checks the environment first and only falls back to the parsed file. So the
`.conf` files generated under `data/etc` on first boot are the stock dist files
and every setting that matters — DataDir, database DSNs, realm id, XP rates —
is set in `compose.yml` instead. Editing `data/etc/*.conf` will *not* override
what compose sets; change compose.

## Bootstrap

`infra/bootstrap/bootstrap.ts` runs on Bun after `db-import`: the chart's
`bootstrap` Job on every install and upgrade, compose's `bootstrap` service
before the servers on the quickstart. It does two things, idempotently:

1. Upserts the `auth.realmlist` row for realm 1 at the configured address
   (loopback, for a port-forwarded client), and deletes any other realm row.
2. Ensures an account (`RUNNER` / `RUNNER` by default) exists with the
   configured password, computing the SRP6 salt and verifier the same way
   `AccountMgr::CreateAccount` does.

The smoke probes that hold a session for minutes (`infra/smoke/module-quest.ts`)
use a second account `PROBE` so they never contend with `RUNNER` for the
one-live-session-per-account limit. Create it, and every extra account
(`SHAKEOUT`, `RUNNER2`, `SMOKE2`), by name:

    bun wb accounts ensure PROBE SHAKEOUT

That is `bootstrap.ts --accounts-only` in the runner pod (`bun wb --local …` on
the quickstart). It creates each named account that is missing, with its name
as its password, and writes nothing else: no realm row, no account that
already exists. A plain `bootstrap.ts` in the runner pod would re-advertise the
realm at the file's defaults, because the pod carries none of the Job's realm
settings; wb refuses the command while the deployed image predates the flag.
The quickstart without Bun on the host can use the `bootstrap` service instead:

    docker compose -f infra/compose.yml run --rm --no-deps \
      -e WRATHBENCH_ACCOUNT_USER=PROBE -e WRATHBENCH_ACCOUNT_PASSWORD=PROBE \
      bootstrap

Either is a pure auth-database write, safe on a running server, but the account
is not usable by the module until it is in the module's allowlist
(`worldserver.accounts` in the chart's values, `AC_WRATH_BENCH_ACCOUNTS` in
compose), which is read when the worldserver is recreated.

`bootstrap.ts` writes SQL directly rather than using SOAP or the worldserver
console. SOAP cannot create the *first* account — `ACSoap.cpp` requires the caller to be
`SEC_ADMINISTRATOR` and the base auth schema seeds no accounts at all — and it
would mean enabling a privileged control path into the world, which the harness
deliberately does not have. The console (attaching to the worldserver, then
`account create ...`, which is what AzerothCore's docker README tells you
to do by hand) is interactive, races the world load, and is not idempotent.
The cost of direct SQL is a small reimplementation of SRP6, pinned to
`src/common/Cryptography/Authentication/SRP6.cpp`; if AzerothCore changes that
derivation, logins fail at the authserver and `bootstrap.ts` is where to look.

The runner account is an ordinary player with no `account_access` row. The
agent gets no GM privileges by contract (`docs/CONTRACTS.md`). A GM operator
account for inspecting the world is created by `infra/spectator-account.ts`,
with the password on stdin so it is never on a command line:

    read -rs P && printf '%s\n' "$P" | bun wb accounts spectator

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
scenarios live in `infra/fixtures/scenarios.ts`, and adding one is a data edit
in that file.

The preflight smokes use fixtures too: `kill-credit.ts` starts from
`vineyard-kill-credit` instead of playing the 783 turn-in that gates the kill
quest, which is why the `fleet` service carries the same `WRATHBENCH_DB_*` env
as `fixtures` — and so does `runner`, where the smokes are exec'd by hand, so

    docker compose -f infra/compose.yml exec runner bun infra/smoke/kill-credit.ts

needs no `-e` flags at all. A benchmark episode cannot pass those credentials
on: `sandboxChildEnv` in `runner/src/sandbox/host.ts` forwards the snippet
child a named list of variables (PATH, HOME, TMPDIR, the sandbox's fault
knobs) plus the four the host sets itself, so no `WRATHBENCH_DB_*` var and
not `WRATHBENCH_MODULE_SECRET`, the module's port secret the smokes present
(`infra/smoke/lib/auth.ts`), reaches it on either service.

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
overwritten by that session's save. The tool polls `characters.online` (up to
`--wait-ms`) and only writes once it reads 0.
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
config and everything but `model` has a default (`infra/run-roster.ts` is the
schema). An unset `effort` means the provider's own default, which is not the
same as any named level.

The codex lane is a directory, so under compose it is BIND-MOUNTED —
`CODEX_HOME` on the host to `/home/bun/.codex` in `runner` and `fleet`,
which is what those services set `CODEX_HOME` to (`x-codex-lane` in
compose.yml). Compose reads the host path from the shell or from
`--env-file .env`; unset or empty, it is `data/codex` in the checkout, which
holds no login until someone runs `codex login` with `CODEX_HOME` pointing
there. Never copied: a second copy of `auth.json` spends the other side's
refresh token.

`--loop` restarts the roster when the list is exhausted, until `--until` or
`--max-hours` (one of which it requires). Cycle 2 onward gets `-cN` run ids;
since a fresh episode wipes the account's characters first, every cycle starts
at level 1 whatever the model names its new one. Loop mode burns tokens, it does not build
a levelling curve.

Before each launch the roster checks whether another run already holds the
entry's account — no termination row and a write in the last few minutes — and
waits (polling, giving up after 30 minutes) rather than launching into
`account_in_use`. An entry without `account` is guarded on
`RUNNER`, so it waits behind a live hand-started run there rather than
launching and failing in seconds. It
only ever *frees* its own session (`DELETE /session` is keyed on
`token == runId`); another process's session is never touched.

No roster file ships in the repo; the fleet materialises one per job from the
config store at `data/runs/fleet-<job>-<date>.roster.json`, which is also the
shape to copy for a hand-written one.

The roster runs its entries sequentially by design. Two characters in parallel
means two roster processes, one per JSON, each with its own account and its
own `--log` path so the two JSONLs do not interleave. **Superseded by the
fleet** (next section) — hand-launching parallel rosters with `--skip` and `&`
still works, but the fleet is the supported way to run more than one
character. If you do launch by hand, do not run two rosters naming the same
model on the same day at the same time: a hand roster derives its run ids
from the model name (`roster-opus-<date>`), so the two entries would be the
same run. Fleet run ids carry the job name (`fleet-<job>-...`), which is how
the fleet sidesteps that collision.


## The fleet

The config store is the whole answer to "what is running right now" —
`docs/RUNBOOK.md`, "Where the config lives"; the viewer's `/config` page
is where it is read and edited, and `infra/fleet.example.json` is the shape.
Its unit of work is the **job**: a roster entry (or a rotation of
several), an episode tier, a repeat count, run as one `run-roster` process on
one game **account**. Accounts have a **class** — `pool`, `paid`, `local`, or
pinned to one job — and the class decides which job may land on them. A job
that names an `account` is pinned to it; a job without one is pool work; and
the scheduling policy makes up jobs of its own for whatever the manual queue
leaves free. Inspect the config, and you have inspected the fleet.

The supervisor (`infra/run-fleet.ts`) runs as the chart's `fleet` Deployment,
or compose's `fleet` service on the quickstart stack. It reads its state where
the data is, so the reports run there too:

    bun wb fleet dry-run      # print the plan
    bun wb fleet status       # read-only report

Steering it, its guards and the config shape are `docs/RUNBOOK.md`, "Steer it"
and "Config reference".

An episode is started through one interface (`infra/episode-launcher.ts`):
a child process of the roster, or — on the cluster, for a probe-campaign arm,
behind the `policy.runPods` setting — its own pod on the arm's image
(`infra/run-pod.ts`, the chart's `templates/run-pods.yaml`). The contract both
sides honour is `docs/ARCHITECTURE.md`, "Launching a run: the run contract";
operating it is `docs/RUNBOOK.md`, "Run pods".

### Local (self-hosted) models

An openai entry may point `apiBase` at a self-hosted OpenAI-compatible endpoint
instead of a cloud pool, for example an LM Studio box on the LAN
(`http://192.0.2.20:1234/v1`, model `qwen/qwen3.8-27b`). A local apiBase
(loopback, RFC-1918 or `.local`) bills free, and its runs land only on the
`local` account class:

- **Claude-barred.** No `claude-*` id ever rides an openai entry, local or
  cloud; claude runs only on the `claude-code` driver.
- **`apiKeyEnv` names a dummy key.** LM Studio ignores the bearer value, but the
  pipeline needs the env var to exist, so `.env` carries a non-secret
  `LMSTUDIO_KEY=lm-studio` placeholder. Delivery mirrors the cloud entries
  exactly: the key travels only in `.env` (Bun autoloads `/wrathbench/.env`
  inside the runner container), never through argv. The adapter still sends its
  attribution headers unconditionally; a local server just ignores them.

Before adding a local model, prove the endpoint can drive the tool loop:

    bun wb smoke local-model

It hits the endpoint directly with one tool definition and no `tool_choice`
(mirroring the adapter), and asserts the model *elects* a tool call whose shape
satisfies the adapter's exact contract. It reports a
clear no-go if the model answers in prose or returns a shape the adapter would
reject. No game account or module needed.

## The derived store

`clickhouse` and `collector` come up with a bare `up`. The viewer and the
publisher read their run listings from ClickHouse; the store is derived and
disposable, and `data/runs` remains the evidence record and the write path
(docs/ARCHITECTURE.md, "The derived store"; `collector/README.md` for the
tables and the resume rules).

Start order is what `depends_on` already encodes: ClickHouse healthy, then the
collector, which applies `collector/schema.sql` at every start — every
statement is `IF NOT EXISTS`, so that is a no-op against a live store and the
thing that makes a collector pointed at an empty database come up rather than
fail.

**Backfilling, and rebuilding after a wipe.** One command, and it is the same
code path the service runs every five seconds:

```
docker compose -f infra/compose.yml run --rm --no-deps collector \
  bun collector/src/main.ts --replay --once
```

`--replay` forgets every offset and reads every run from byte zero. It is safe
to run against a store that already has the rows: every table is keyed on
something replay reproduces exactly, so re-ingesting is idempotent rather than
additive (a `SELECT ... FINAL` sees one row either way, and the background
merge collapses the duplicates). Expect roughly 30 seconds per gigabyte of
trajectory.

**When ClickHouse is rebuilt from scratch** — a bad image bump, a corrupted
volume, a deliberate wipe to reclaim the disk:

```
docker compose -f infra/compose.yml down clickhouse
docker volume rm wrathbench_clickhouse-data
rm -f data/collector/collector.sqlite*        # or pass --replay below
docker compose -f infra/compose.yml up -d clickhouse collector
```

Deleting the offset database and letting the collector start normally has the
same effect as `--replay`: there is nothing to resume from, so it reads
everything. Either is fine; do not do both halfway. Nothing is lost by any of
this, which is the point of the store being derived — the worst case is a
viewer that is behind until the backfill finishes.

**When the collector is behind.** It logs one line per pass that found
something. `docker compose -f infra/compose.yml logs -f collector` is the
whole diagnostic; a ClickHouse that is down shows up as one
"clickhouse unavailable, retrying" line and nothing else until it comes back.
Offsets only ever advance past rows ClickHouse acknowledged, so a collector
that has been waiting all night resumes exactly where it stopped.

## Where data lives

`data/` is gitignored at the directory level and holds everything
Blizzard-derived or run-specific; `compose.yml` is where each piece is mounted.

The MySQL data directory is the named volume `db-data`, not a bind mount.
`docker compose down` keeps it; `docker compose down -v` throws the world away
and the next `up` re-imports from scratch.

## Releasing on Kubernetes

```
bun wb release run --dry-run
bun wb release run --pin-hook <your pin hook>
```

`bun wb release run` is `infra/k8s-release.sh`, with every flag passed through.

Five phases, run in order, each one idempotent and each one restartable with
`--from <phase>`:

| phase | what |
|---|---|
| `build` | `build-images.sh --push` at `git describe` of this tree, built from a `git archive` of that commit and scanned by `image-guard.sh` before the push; refuses a dirty tree |
| `drain` | `fleet-update.sh drain` — the pause switch stays set for the whole window |
| `pin` | place the pin, then **wait until the cluster actually carries the tag** |
| `deploy` | `k8s-deploy.sh` — the gate smokes, then the fleet comes back |
| `resume` | `fleet-update.sh resume`; skipped, and said so, under `--keep-paused` |

**The pin is a hook, because how a pin is placed is yours.** This repo knows the
tag and what the chart does with it; it does not know whether your GitOps repo
takes a commit, a pull request, a `helm upgrade --set`, or a person with an
editor. So: your GitOps repo places the pin, and you point `--pin-hook` at
whatever does that for you. It is run as

```
<command> <tag> <sha>          with WRATHBENCH_TAG and WRATHBENCH_SHA set
```

and only has to return once the pin is *placed*. It does not have to wait for
the cluster: the `pin` phase does that itself, by reading the image tag the
worldserver and viewer Deployments actually run and then waiting out every
rollout. That is the check a hook cannot get wrong, and the one a release needs
— a deploy window that runs against a pin that never merged smokes
the old release and calls it verified. With no hook the phase prints the tag,
the commit and where the chart expects them, and waits for the same thing, so
placing a pin by hand still works.

`--helmrelease <namespace>/<name>` adds one more wait after the tag poll, never
instead of it: a HelmRelease is still `Ready` on the previous revision, so
waiting on it alone would return instantly and hand the deploy window the old
image.

`k8s-deploy.sh` (`bun wb release deploy`) makes the same check on its own and **refuses** when the cluster
is not on this tree's tag — `--expect-tag <tag>` requires a different one and
`--allow-tag-mismatch` is the deliberate override. It also clears the pause
switch a `drain` left set when it reaches its resume phase, and says so; a
failed window deliberately leaves it set. `--keep-paused` (on either script)
leaves it set on every path, setting it before the drain if nothing had, so the
fleet comes back up resuming nothing until the operator has smoked the build
with real runs (docs/RUNBOOK.md, "Deploying a harness change that needs a real
smoke first").

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
