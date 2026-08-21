# infra

Everything runs in containers from `infra/compose.yml`. Host-side work is
limited to the one-time client data extraction.

## Bringing the stack up

From the repository root, on a fresh machine:

```
mkdir -p data/{client,wiki,runs,etc,logs}
./infra/extract-client-data.sh   # once, needs a local 3.3.5a client; see EXTRACTION.md
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

Nothing is published to the host. The realm is reachable only from inside the
`wrathbench` bridge network; per `docs/DATA-AND-LEGAL.md` there is no public
play endpoint, and 8085 and 3724 in particular must never leave the network. If
you need a port for debugging, bind it to `127.0.0.1` explicitly and do not
commit it.

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
agent gets no GM privileges by contract (`docs/CONTRACTS.md`). If you need an
operator account for debugging, create it by hand from the worldserver console:

```
docker compose -f infra/compose.yml attach worldserver
AC> account create admin <password>
AC> account set gmlevel admin 3 -1
```

Override the defaults with `WRATHBENCH_ACCOUNT_USER`,
`WRATHBENCH_ACCOUNT_PASSWORD`, `WRATHBENCH_REALM_NAME`, and
`WRATHBENCH_DB_ROOT_PASSWORD` in the environment or a local `.env`. Usernames
and passwords are uppercased before hashing, as AzerothCore does; use uppercase
values to keep that a non-question.

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
