# Deploying WrathBench on NuSphere

The runbook for running the stack on the k3s cluster instead of on the
workstation's docker compose. Architecture is `docs/ARCHITECTURE.md`; day-to-day
operation, once it is running, is `docs/OPERATIONS.md` — the fleet is steered by
`infra/fleet.json` there exactly as it is here.

## What this is, and what it is not

The chart is a lift of `infra/compose.yml`, not a redesign. Every service keeps
its name, its env, its mounts and its posture. The two things that genuinely do
not port are the ones GitHub issue 7 names: the repo bind mount (so the harness
is baked into the runner image and the `git describe` stamp comes from a build
arg) and `.env` (so the secrets arrive from a Kubernetes Secret). Everything
else is the same stack.

Nothing about the cluster changes what the agent can see or do. The action path
is still the module, still the same opcode handlers a client would hit
(`docs/CONTRACTS.md`).

## Decisions behind the shape

These are the operator's, made 2026-09-05.

**The chart lives in this repo**, at `infra/chart/wrathbench`, not in a chart
repository of its own. Nothing in it is reusable outside WrathBench — it is one
realm, one supervisor, one viewer — and it has to version with the images it
deploys, which are built from this tree. A Flux `HelmRelease` in the cluster
repo consumes it from a pinned **commit** of this repo (`ref.commit`, never a
branch) with `chart.spec.chart: infra/chart/wrathbench` and
`reconcileStrategy: Revision`, so a new source revision deploys even though
`Chart.yaml`'s version has not moved. Not a git tag, deliberately: the harness
version every run is stamped with is `git describe --tags`, so a deployment tag
on this repo would become the nearest tag and relabel every run launched after
it, and its series with it. The commit that is pinned is the commit the images
were built from, so `image.tag` (`harness-0.5-N-g<sha>`) names the same
revision — issue 7's "one source SHA".

**Storage is `iscsi-nvme`, Retain, for every volume.** RWO, expandable, and an
honest fsync — which matters because every run's evidence is a SQLite file and
a JSONL stream. Retain means deleting the release does not delete a run; the
PVCs also carry `helm.sh/resource-policy: keep`. One PVC (`wrathbench-data`,
60Gi) holds `client/ runs/ wiki/ minimap/ etc/ logs/ publish/` in exactly
today's layout; a second (`wrathbench-db`, 20Gi) is the MySQL datadir; a third
(`wrathbench-codex-home`, 1Gi) is the codex lane below.

That one RWO volume is mounted by five pods at once. That is sound only because
every pod carries `nodeSelector: kubernetes.io/hostname: chungusjr` — they are
all on the same node, so RWO is satisfied. It is **not** an argument for RWX:
the volume wants one node, and the cluster's other node is a tainted 1-cpu edge
box that must never run any of this.

**Game ports stay ClusterIP.** No MetalLB, no NodePort, and no Ingress for the
module, MCP or game ports — ever. Spectating is a port-forward (below). The one
Ingress in the chart is the LAN viewer at `wrathbench.local`, with a certificate
from the `nusphere-ca` ClusterIssuer. Both the host and the issuer are values,
not literals in a template.

**Images are pinned by immutable tag**, `git describe --tags --always` of the
source SHA, in the public Harbor project `harbor.local/library`. `latest` is not
merely discouraged: the chart refuses to render with `image.tag` empty or
`latest`. The same string is the four image tags, `image.tag` in the
HelmRelease, `WRATHBENCH_BUILD` on the worldserver (the module's `/health`
`build` field), and `WRATHBENCH_HARNESS_VERSION` on every trajectory the fleet
produces — so the deployed revision, the server identity and a run's stamp all
agree and are reviewable.

## What is never exposed

`docs/PUBLIC-DASHBOARD.md` is the authority and says it plainly: the public
surface is the static artifact bucket and the SPA in front of it, **never a
viewer, module or MCP Service or Ingress**. The viewer is operator-only —
it reads the runs directory, tails live trajectories, holds an SSE connection
per watcher, and answers `/api/info` about the lab — and
`WRATHBENCH_VIEWER_PUBLIC=1` is a *projection boundary*, not a hardening
measure. It does not make the viewer safe to expose and the chart does not set
it.

So, concretely, in this chart:

- one Ingress, for the viewer, on the LAN name only;
- `worldserver` (8085 world, 8086 module), `authserver` (3724) and
  `wrathbench-db` (3306) are ClusterIP, reachable inside the namespace and from
  a `kubectl port-forward`;
- the publisher has no Service at all: it makes outbound HTTPS requests and
  nothing listens.

## Prerequisites

- `harbor.local/library` is a public Harbor project, so no pull secret. The
  workstation is logged in and has the registry in `insecure-registries`.
- Namespace `wrathbench`.
- Secret `wrathbench-env`, created by the cluster repo. Its keys are the `.env`
  names:

  ```
  WRATHBENCH_MODULE_SECRET      WRATHBENCH_DB_ROOT_PASSWORD
  WRATHBENCH_ACCOUNT_USER       WRATHBENCH_ACCOUNT_PASSWORD
  CLAUDE_CODE_OAUTH_TOKEN       CLAUDE_CODE_OAUTH_TOKEN_2
  OPENROUTER_KEY                OPENCODE_KEY
  CEREBRAS_KEY                  LMSTUDIO_KEY
  S3_ACCESS_KEY_ID              S3_SECRET_ACCESS_KEY
  S3_BUCKET                     S3_ENDPOINT
  ```

  `CF_API_KEY_DEPLOY` and `WRATHBENCH_PUBLIC_ORIGIN` stay on the workstation:
  they belong to `infra/deploy-dashboard.sh`, which builds and ships the public
  SPA and is a separate, review-gated concern (issue 7 is explicit that this
  pipeline does not publish the site).

- ConfigMap `wrathbench-fleet-config`, key `fleet.json`, generated by a Flux
  Kustomization pointed at `./infra/k8s` in this repo. The chart ships no copy
  of `fleet.json`; see "Steering the fleet" below.

### `.env` became env, and why that is still "never via argv"

Issue 7 says the Secret should be mounted at the same path so `.env` survives.
It is delivered as **environment** instead, from the Secret, and the file does
not exist in the pod. The reason `.env` existed was to keep secrets off the
command line — `ps` is a broadcast channel — and env from a Secret does that at
least as well: it never appears in a manifest, in `helm get manifest`, or in
Flux's diff.

The keys are named individually rather than pulled in with `envFrom` on the
whole Secret, and that is not tidiness. `sandboxChildEnv` forwards every
`WRATHBENCH_*` variable to the snippet child except `WRATHBENCH_DB_*` and the
module secret — an allowlist written against what the compose fleet actually
holds. `envFrom` would put `WRATHBENCH_ACCOUNT_PASSWORD` in the pod (the
compose fleet never has it; it is not in `.env`, only on the bootstrap service)
and the allowlist would forward it into a model's sandbox. Enumerating keeps
the pod's environment the shape the allowlist was designed for. The publisher
holds the four `S3_*` names and no model key; the viewer holds the module
secret and nothing else.

What the file also bought was keeping keys away from the snippet sandbox, and
that does not depend on it. Three independent things do:

1. `sandboxChildEnv` (`runner/src/sandbox/host.ts`) is an **allowlist** — the
   child gets `PATH`, `HOME`, `TMPDIR` and `WRATHBENCH_*` minus `WRATHBENCH_DB_*`
   and the module secret. `OPENROUTER_KEY` and friends are not forwarded at all.
2. The child is spawned `bun --env-file=/dev/null`, so nothing is autoloaded.
3. The child is exec'd through `confine.ts`, whose Landlock ruleset lets it read
   the interpreter, `runner/`, `sdk/` and `node_modules/` and nothing else — not
   `/proc`, not `$HOME`, not any `.env` by any path — and which fails closed if
   the kernel or the container refuses the ruleset.

Verified 2026-09-05 on `chungusjr` (kernel 6.13, containerd 2.2, Landlock ABI 6)
that containerd's `RuntimeDefault` seccomp profile permits
`landlock_create_ruleset` / `landlock_add_rule` / `landlock_restrict_self`, so
the pods set `seccompProfile: RuntimeDefault` and the confinement still applies.

## Build and push

```
./infra/build-images.sh --push
```

Builds four images — worldserver, authserver, db-import (targets of
`infra/docker/server.Dockerfile`) and runner — and tags them
`harbor.local/library/<name>:<git describe>`. It refuses a dirty tree unless
`--allow-dirty`, and refuses to push a dirty tag at all. The worldserver's C++
build reuses the same BuildKit ccache mount `infra/build-worldserver.sh` warms,
so a module-only change rebuilds in minutes.

The runner image is the one that changed shape: it `COPY`s the repo, runs
`bun install --frozen-lockfile`, and builds `dashboard/dist` (gitignored, so it
exists nowhere else and the viewer would otherwise serve its "how to build it"
notice). Its ignore list is `infra/docker/runner.Dockerfile.dockerignore` —
BuildKit prefers a per-Dockerfile ignore file, which is what lets the runner
image include `runner/`, `sdk/`, `wiki/` and `docs/` while the root
`.dockerignore` keeps them out of the server images.

Then, in the cluster repo, set `image.tag` to the printed tag and let Flux
reconcile. **Flux owns the tag. Nothing in this repo changes it.**

## Steering the fleet

`infra/fleet.json` is the single source of truth on compose and on Kubernetes
alike. `infra/k8s/kustomization.yaml` is a `configMapGenerator` over it with
`disableNameSuffixHash: true`, and the cluster repo applies that path with a
Flux Kustomization from the same GitRepository the HelmRelease reads.

So steering is what it always was: edit `infra/fleet.json`, commit, and the
supervisor's next 60-second re-read picks it up. Two details make that true and
both are load-bearing:

- the chart mounts the ConfigMap as a **directory** at `/wrathbench/config`, not
  a `subPath` file. A `subPath` mount is copied once at container start and
  never updated, which would turn hot steering into a silent no-op.
- the generated name is **not** content-hashed, so the ConfigMap does not change
  identity on every edit and the fleet Deployment is not rolled — a restart
  would drop live episodes, which is precisely what hot re-read exists to avoid.

`../fleet.json` from `infra/k8s` needs `LoadRestrictionsNone`, which is what
Flux's kustomize-controller builds with. To check it by hand:

```
kustomize build --load-restrictor LoadRestrictionsNone infra/k8s
```

## The codex lane

The `codex` driver's subscription lane is not a key. It is a logged-in Codex
home *directory* — `auth.json` plus the persisted threads — and the CLI writes
its ChatGPT token refresh back into it as it runs. That is why nothing
codex-related is in the Secret, and why `codex.enabled` gives the fleet and
runner pods a PVC (`wrathbench-codex-home`) mounted at `/home/bun/.codex` — a
directory, not a `subPath` file — with `CODEX_HOME` pointing at it.

**It is seeded once and never copied again.** A second live copy of a logged-in
home does not give you two lanes: the first refresh from either side invalidates
the other and the next call fails with "refresh token was already used" (seen on
this host 2026-09-05). So the seed in the cutover below runs exactly once, after
the compose fleet is stopped so nothing is refreshing concurrently, and from
that point the cluster copy is the canonical lane. Do not point host fleet work
at `~/.codex` afterwards — a `--local` episode on the workstation is a second
live copy and will log the cluster out.

If the lane ever does lapse, re-authenticate it in place rather than re-seeding:

```
kubectl -n wrathbench exec -it deploy/wrathbench-runner -- codex login --device-auth
```

The device flow prints a code to enter in a browser anywhere, so it needs no
loopback redirect and no display in the pod. The fleet pod shares the volume, so
it picks up the refreshed home with no restart.

## The cutover

Runs pause and resume; nothing is lost. Do it in a window you are watching.

1. **Stop the compose fleet.** Every live run pauses and is resumed by whichever
   supervisor comes back first.

   ```
   docker compose -f infra/compose.yml stop fleet
   ./infra/run-fleet.sh --status          # confirm no job is alive
   ```

2. **Dump the three databases** from the compose db.

   ```
   docker compose -f infra/compose.yml exec -T db sh -c \
     'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" \
      --single-transaction --routines --events \
      --databases acore_auth acore_characters acore_world' > /tmp/wrathbench.sql
   ```

   The password comes from the container's own environment, not the shell's:
   the repository `.env` does not set `WRATHBENCH_DB_ROOT_PASSWORD` (compose
   defaults it), so a host-side expansion sends an empty password and mysqldump
   fails with access denied. The single quotes are load-bearing for the same
   reason, and the redirect stays outside them.

3. **Install the chart** (Flux reconciles the HelmRelease). The hook Jobs run
   `dbimport` and then `bootstrap`; both are idempotent, so the restore in step
   6 can happen before or after them. Let the db Deployment become ready.

4. **Seed the data volume.** Start a throwaway pod that mounts
   `wrathbench-data` as uid 1000, then rsync into it. `data/client` is the big
   one and is the operator's own extraction — never in git, never in an image.

   ```
   kubectl -n wrathbench run wb-seed --restart=Never --image=oven/bun:1.4.0 \
     --overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"chungusjr"},
       "securityContext":{"runAsUser":1000,"runAsGroup":1000,"fsGroup":1000},
       "containers":[{"name":"seed","image":"oven/bun:1.4.0","command":["sleep","infinity"],
         "volumeMounts":[{"name":"data","mountPath":"/data"}]}],
       "volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"wrathbench-data"}}]}}'

   for d in client runs wiki minimap etc publish; do
     kubectl -n wrathbench exec wb-seed -- mkdir -p "/data/$d"
     tar -C data -cf - "$d" | kubectl -n wrathbench exec -i wb-seed -- tar -C /data -xf -
   done
   ```

   (`rsync` is nicer if you install it into the pod; `tar` over `exec` needs
   nothing and is idempotent enough for a one-shot seed. Re-running it is safe.)

   Leave `wb-seed` running: the seed copies everything, and if the seed and the
   cutover are separate windows — which is the point of staging the bring-up —
   the runs written in between still have to follow. Delta-copy them with the
   same pod, naming the seed's own timestamp:

   ```
   cd data && find runs publish -newermt '<seed time>' -type f -print0 \
     | tar --null -T - -cf - \
     | kubectl -n wrathbench exec -i wb-seed -- tar -C /data -xf -
   ```

   Then check the two sides agree before you trust it: the run-directory count,
   and the `md5sum` of `run.sqlite` for each live stream head, then delete the
   pod — step 5 starts its own, on the lane volume.

5. **Seed the codex lane, once.** The compose fleet is already stopped (step
   1), which is the precondition: two live copies of a logged-in Codex home
   invalidate each other. Same throwaway pod, this time on the lane volume.

   ```
   kubectl -n wrathbench run wb-seed --restart=Never --image=oven/bun:1.4.0 \
     --overrides='{"spec":{"nodeSelector":{"kubernetes.io/hostname":"chungusjr"},
       "securityContext":{"runAsUser":1000,"runAsGroup":1000,"fsGroup":1000},
       "containers":[{"name":"seed","image":"oven/bun:1.4.0","command":["sleep","infinity"],
         "volumeMounts":[{"name":"codex","mountPath":"/codex"}]}],
       "volumes":[{"name":"codex","persistentVolumeClaim":{"claimName":"wrathbench-codex-home"}}]}}'

   tar -C ~/.codex -cf - . | kubectl -n wrathbench exec -i wb-seed -- tar -C /codex -xf -
   kubectl -n wrathbench delete pod wb-seed
   ```

   The extract ends with exit status 2 and `Cannot change mode ... Operation
   not permitted` for `.` — the mount root's mode is the volume's, not the
   tarball's. The files land; that one line is expected and nothing else in the
   output should be. Confirm the lane rather than the exit code:
   `kubectl -n wrathbench exec deploy/wrathbench-runner -- codex login status`
   reports "Logged in using ChatGPT".

   Unlike the data seed this is not re-runnable: see "The codex lane" above for
   why there is no second copy, and how to re-authenticate it in place instead.

6. **Restore the dump** into the cluster db.

   ```
   kubectl -n wrathbench exec -i deploy/wrathbench-db -- \
     sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD"' < /tmp/wrathbench.sql
   ```

   Same reason as step 2, and scale `worldserver` and `authserver` to 0 first so
   nothing holds a connection while the databases are replaced. Count characters
   and accounts against the source before scaling them back.

7. **Preflight, with the fleet still off.**

   ```
   ./infra/k8s-deploy.sh --dry-run     # read the resolved values first
   ./infra/k8s-deploy.sh
   ```

   That drains (scale to 0 and wait on `fleet-state.json`, read through the
   runner pod), waits for the worldserver rollout and for the module to answer
   `/health` ready **with the bearer**, runs `preflight.smokes` and then
   `preflight.deploySmokes` through `kubectl exec deploy/wrathbench-runner`, and
   scales the fleet back.

   Run it here, before the flags, so the gate smokes prove the restored world on
   the new build without an episode racing them. That ordering has one cosmetic
   cost: with `fleet.enabled: false` there is no fleet Deployment to scale back,
   so the script's EXIT trap reports **"phase failed: the fleet did not scale
   back up"** and writes `phase=failed` into `server-state.json` even though
   every smoke passed. Read the smoke results, not the trap; the supervisor
   clears the flag on its next start ("phase failed -> running"). The script is
   correct for the day-2 case and is deliberately left alone.

8. **Flip the flags.** In the cluster repo, set `fleet.enabled` and
   `publisher.enabled` to `true` and let Flux reconcile. The supervisor gates
   itself on start — the same smokes again — and then resumes the runs that
   paused in step 1.

9. **Confirm** on the viewer at `https://wrathbench.local` that the runs you
   paused in step 1 are live again on the new server build, and that
   `/api/info` reports the image tag you pinned.

Leave the compose stack down but installed until you are satisfied.

## Day 2

```
./infra/k8s-deploy.sh                            # the deploy window
./infra/fleet-update.sh status                   # what the fleet is doing
./infra/run-episode.sh --model <id> --k8s        # one ad-hoc episode
kubectl -n wrathbench logs -f deploy/wrathbench-fleet
kubectl -n wrathbench exec -it deploy/wrathbench-runner -- bash
```

`infra/k8s-deploy.sh` is `infra/deploy-worldserver.sh` with the compose verbs
swapped for `kubectl`. Two things are deliberately different:

- **It does not change the image tag, and it does not roll back.** Flux owns
  the tag; a rollback is reverting `image.tag` in the cluster repo to the
  previous immutable tag and letting Flux reconcile. The script says so when it
  fails, leaves the fleet up (its own gate blocks spawning until a build
  passes), and exits 1.
- **There is no deploy lock.** The compose script holds an `flock` on
  `server-state.lock` for its whole window; an `flock` taken inside a
  `kubectl exec` dies with the exec, so holding one here would be a lie and is
  not faked. Keep the window to one operator. The mutual exclusion that matters
  on the cluster is that exactly one thing — Flux — can change what is deployed.

### The ops scripts, and which of them still speak compose

Ported to kubectl on 2026-09-11, after `fleet-update.sh status` reported the
live cluster fleet as "container not running, heartbeat 260151s ago" — it was
still asking `docker compose ps`, and an operator sizing a deploy window was
being told the fleet was dead.

- **`infra/fleet-update.sh`** — the supervisor roll, and the only steering that
  does not go through Flux. Same five verbs, same semantics, kubectl underneath:

  ```
  ./infra/fleet-update.sh status      # switch, state file, Deployment, pods
  ./infra/fleet-update.sh graceful    # pause, wait for quiet, restart, resume
  ./infra/fleet-update.sh force       # restart NOW (--yes to skip the prompt)
  ./infra/fleet-update.sh drain       # pause, wait for quiet, SCALE TO 0
  ./infra/fleet-update.sh resume      # clear the pause switch
  ./infra/fleet-update.sh graceful --dry-run   # every kubectl command it would run
  ```

  Three things about the port are worth knowing. **Reads and writes of
  `fleet-state.json` and the pause switch go through the RUNNER pod**, not the
  fleet's own — same PVC, same files, and the runner is the exec target because
  the fleet pod is the thing being recreated; `infra/k8s-deploy.sh` already read
  it that way. **A recreate is `kubectl rollout restart`** on a Deployment whose
  strategy is `Recreate`, so the old supervisor gets its full 180s grace and two
  never overlap; a fleet already at 0 is scaled back to 1 instead, because a
  rollout restart of nothing restarts nothing. And **`drain` scales to 0**
  rather than stopping a container, which is the one verb whose exit shape
  changed: `resume` after a drain now says so and names the `--replicas=1` that
  has to follow it.

  What did not change: the pause switch is still the sidecar file the supervisor
  reads every tick, `graceful` still waits only on the runs a recreate would
  COST (a draining freeplay stream or a `resume: true` campaign run resumes in
  place and is counted as drained), an abort still leaves the switch SET, and a
  supervisor that does not come back still leaves it set on purpose.

  Three things the cluster forced that compose did not. **"Did it come back?"
  is `startedAt`, not a timestamp comparison** — the supervisor stamps
  `const START_AT = Date.now()` once per process, and waiting for that value to
  CHANGE never asks the workstation clock and `chungusjr`'s to agree; "is this
  heartbeat later than the moment I typed the restart" would, and a pod a few
  seconds ahead would read a dying supervisor's last write as a boot and clear
  the switch under a fleet that never came back. **A failing kubectl says the
  switch is set**, via an ERR trap next to the Ctrl-C one: an API blip is
  likelier than an interrupt and `set -e` alone would exit silently. And
  **`drain` waits for the pod to be GONE**, not for `rollout status` — which on
  a Deployment scaled to 0 does not reliably wait for a pod that is still
  Terminating, and the supervisor spends up to its 180s grace in there writing
  the pause records the next one resumes from.

- **`infra/viewer-restart.sh`** — rollout-restarts the `wrathbench-viewer`
  Deployment and checks `https://wrathbench.local/api/info`. On the cluster the
  viewer's code is baked into the runner image and Flux owns the tag, so this
  kicks a wedged process; new viewer code needs a new tag.
  `--local` drives the retired workstation path (systemd user unit or nohup) and
  exists for the rollback below.
- **`infra/module-health.sh`** — the module's operator census, `kubectl exec`
  into the worldserver pod. `--compose` is the rehearsal stack.
- **`bun run publisher:restart`** — `kubectl rollout restart` of the publisher
  Deployment; `publisher:restart:compose` is the rehearsal one.
- **`bun run deploy:worldserver`** now runs `infra/k8s-deploy.sh`.
  `deploy:worldserver:compose` is `infra/deploy-worldserver.sh`, which is
  compose-only and says so in its header.

Still compose-only, deliberately, and all of them say so in their headers:
`infra/deploy-worldserver.sh`, `infra/build-worldserver.sh` (a local build, not
a deploy), `infra/wrathbench-viewer.service` (retired 2026-09-08, rollback
only), and `infra/compose.yml` itself, which stays as the documented local
rehearsal. `infra/run-fleet.ts`, `infra/run-roster.ts` and `run-episode.sh`
already branch on `WRATHBENCH_IN_CONTAINER`, so the fleet pod never reaches for
a docker CLI; a handful of their operator-facing strings still name compose
paths, which is cosmetic drift and not a wrong action.

## Rollback to compose

The compose stack is not modified by any of this and can be brought back:

1. `kubectl -n wrathbench scale deploy/wrathbench-fleet --replicas=0` and wait
   for the drain (runs pause).
2. `mysqldump` out of `deploy/wrathbench-db`, restore into the compose `db`.
3. `tar`/`rsync` `runs/` and `publish/` back out of the data PVC into `data/`,
   and the codex lane out of `wrathbench-codex-home` into `~/.codex`. The
   one-live-copy rule runs in this direction too: the host copy went stale the
   moment the cluster first refreshed it, and compose's `x-codex-lane` mounts
   `~/.codex` unconditionally while the supervisor's preflight only checks that
   `CODEX_HOME` is set — so without this the fleet comes up green and every
   codex episode fails at its first call. The fleet must already be scaled to 0
   (step 1). Re-authenticating on the host with `codex login --device-auth` is
   the alternative, and it invalidates the cluster copy, which is what you want
   when the rollback is for good.
4. `docker compose -f infra/compose.yml up -d` then
   `docker compose -f infra/compose.yml up -d --no-deps fleet`.

The PVCs are `Retain` and carry `helm.sh/resource-policy: keep`, so nothing is
destroyed by uninstalling the release.

## Spectating

No port is exposed. Forward the two the client needs, and connect to
`127.0.0.1` — which is exactly what the realmlist row advertises, by design
(`realm.address` in values, `127.0.0.1`, never a routable address):

```
kubectl -n wrathbench port-forward svc/authserver 3724:3724
kubectl -n wrathbench port-forward svc/worldserver 8085:8085
```

Then point a 3.3.5a client's `realmlist.wtf` at `127.0.0.1`.

## What stays on the workstation

- **`data/client-source`** — the extraction inputs. Nothing Blizzard-derived is
  in git or in an image, and only the extracted server data directory
  (`data/client`) goes onto the cluster volume, read-only
  (`docs/DATA-AND-LEGAL.md`).
- **The public dashboard deploy** — `infra/deploy-dashboard.sh`, the Cloudflare
  credentials, and `WRATHBENCH_PUBLIC_ORIGIN`. Review-gated and separate; the
  cluster only runs the *publisher*, which pushes JSON to the bucket and listens
  for nothing.
- **Server logs beyond the module's audit trail.** `Server.log` goes to the
  container's console (`AC_APPENDER_SERVER=1,5,0`) and `kubectl logs` is the
  history; the compose value was a File appender with per-boot timestamped
  backups and that tree reached 22 GB. `Errors.log` and the module's audit
  directory stay on the PVC, because they are evidence.
- **A compose rollback path, and nothing else.** The LAN viewer runs on the
  cluster behind the Ingress now; `infra/wrathbench-viewer.service` and
  `infra/viewer-restart.sh` still exist and the systemd user unit is disabled,
  kept only for the rollback below.
- **The LM Studio box at 192.168.1.20.** Local models are reached over the LAN
  from wherever the fleet runs; the cluster reaches it the same way the
  workstation did. Nothing about it moves.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `master`,
cancelling superseded runs on the same ref and asking for nothing but
`contents: read`. Two jobs. **Bun checks** pins Bun from `.bun-version` (and
asserts the running version equals the pin, so a silent drift in the setup action
is a failure and not a surprise), installs with `--frozen-lockfile`, then runs
what the repo already has, ordered cheap to expensive: `bun run typecheck`,
`bun run docs:api:check` (regenerates `sdk/API.md` and fails if it differs from
what is committed), `bun run dashboard:build`, and `bun test`. **Helm chart** is
separate so a chart problem cannot read as a test problem: `helm lint` and
`helm template` against `infra/chart/wrathbench` with a dummy immutable
`image.tag`, since the chart refuses `""` and `latest` by design.

It runs from a bare clone — no `.env`, no `data/`, no submodule. That is the same
property CLAUDE.md asks the suite to keep, and CI is now the thing that notices
when it stops being true.

## Owed

Nothing on the release side. The operator decided on 2026-09-11 that the
release contract is the shape already running, and that the "release half" of
issue 7 — a tag workflow building the images in public CI, the chart as an OCI
artifact, a review-time mutable-reference check — is not wanted: Flux deploys
from the pinned WrathBench commit and pulls from a LAN-only registry, and a
public workflow could neither reach that registry nor add traceability the
`git describe` tag of a clean tree does not already carry. So the images are
built and pushed from the workstation (`infra/build-images.sh --push`), the
cluster repo pins commit and tag, Flux rolls, and the deploy window is
`infra/k8s-deploy.sh`. Nothing about deployment is exposed through public CI,
which is the point. The C++ module build stays out of CI: it needs the
worldserver image, and the smoke scripts in `infra/smoke/` need the live stack.
