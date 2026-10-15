{{/*
Naming.

WrathBench workloads are named <release>-<component>; the release is expected
to be `wrathbench`, so the Deployment for the fleet is `wrathbench-fleet` and
`kubectl -n wrathbench exec deploy/wrathbench-runner` is the documented handle.

TWO SERVICES ARE UN-PREFIXED, DELIBERATELY: `worldserver` and `authserver`.
Those bare hostnames are compiled into the harness as defaults —
runner/src/config.ts, runner/src/sandbox/entry.ts, infra/run-fleet.ts,
infra/run-roster.ts and every smoke's MODULE_HOST all say `worldserver:8086` —
and inside the namespace they resolve through the pod's DNS search path.
Renaming them to match the house prefix breaks every one of those defaults at
once, silently, at the first episode rather than at deploy. Do not tidy them.

The database Service IS prefixed (`wrathbench-db`), because nothing compiles
that name in: bootstrap.ts's `db` is only a default, and the AC_*_DATABASE_INFO
strings are built here. A backup CronJob outside the chart runs mysqldump
against `wrathbench-db` and mounts the `wrathbench-data` PVC by name, so both
names are part of the interface and are not renamed on this side alone.
*/}}

{{- define "wrathbench.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "wrathbench.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "wrathbench.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "wrathbench.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Pod-template labels: `wrathbench.labels` minus everything that moves with the
release.

A Deployment or StatefulSet replaces its pods whenever any byte of
spec.template changes, labels included. `helm.sh/chart` carries the chart
version, which a git-sourced chart gets stamped with the source revision
(`0.1.0+<sha>`, rendered `0.1.0_<sha>`), and `app.kubernetes.io/version`
carries the image tag. In a pod template those two made EVERY upgrade replace
EVERY pod, whether or not anything about that pod had changed — including the
two databases, whose images are upstream pins that no release moves. For
MySQL and ClickHouse a replacement is downtime plus a full detach and
reattach of their volume, for nothing.

So pod templates carry only labels that are constant for the life of the
release, and a pod rolls when its OWN inputs change: its image, its env, its
volumes, or a checksum of its own config (ClickHouse's drop-ins). Every
workload built from the release's images still rolls on every tag bump,
because the tag is in its image reference — it just no longer rolls a second
time for a chart revision that did not touch it. The workload objects
themselves keep the full `wrathbench.labels`, so which chart and tag a
Deployment came from is still on the Deployment.

Never put anything per-commit, per-version, time-based or random in here, or
in a pod annotation; the hook Jobs are exempt, being recreated on every
upgrade anyway. `infra/chart/stable-pod-templates.sh` (run in CI) fails if the
database pod templates differ between two releases.
*/}}
{{- define "wrathbench.podLabels" -}}
app.kubernetes.io/name: {{ include "wrathbench.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* The immutable tag, validated. */}}
{{- define "wrathbench.tag" -}}
{{- $t := required "image.tag is required: the immutable tag (`git describe` of the source SHA) that this release deploys. See GitHub issue 7 — no mutable default may become the deployment source." .Values.image.tag | toString -}}
{{- if or (eq $t "") (eq $t "latest") -}}
{{- fail "image.tag must be an immutable tag; \"\" and \"latest\" are refused — see GitHub issue 7" -}}
{{- end -}}
{{- $t -}}
{{- end -}}

{{/* The image registry, validated. One cluster's registry is not a default. */}}
{{- define "wrathbench.registry" -}}
{{- required "set image.registry: the registry (and any project path) the WrathBench images are pushed to, e.g. registry.example.com/wrathbench." .Values.image.registry -}}
{{- end -}}

{{- define "wrathbench.image.worldserver" -}}
{{ include "wrathbench.registry" . }}/{{ .Values.image.names.worldserver }}:{{ include "wrathbench.tag" . }}
{{- end -}}
{{- define "wrathbench.image.authserver" -}}
{{ include "wrathbench.registry" . }}/{{ .Values.image.names.authserver }}:{{ include "wrathbench.tag" . }}
{{- end -}}
{{- define "wrathbench.image.dbImport" -}}
{{ include "wrathbench.registry" . }}/{{ .Values.image.names.dbImport }}:{{ include "wrathbench.tag" . }}
{{- end -}}
{{- define "wrathbench.image.runner" -}}
{{ include "wrathbench.registry" . }}/{{ .Values.image.names.runner }}:{{ include "wrathbench.tag" . }}
{{- end -}}

{{/*
Pod security. uid/gid 1000 everywhere: the runner image's `bun` user and the
server images' `acore` user are both 1000, and the data PVC is written by both.
fsGroup makes the volume group-writable for them.
*/}}
{{- define "wrathbench.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  # Verified on the reference node (kernel 6.13, containerd 2.2, Landlock ABI
  # 6): containerd's RuntimeDefault profile permits landlock_create_ruleset /
  # landlock_add_rule / landlock_restrict_self, so the snippet sandbox's
  # confinement (runner/src/sandbox/confine.ts) still applies. If that ever
  # stops being true the wrapper fails closed and no snippet runs at all.
  type: RuntimeDefault
{{- end -}}

{{/*
The pull Secrets every WrathBench-image pod carries. The images live in a
private Harbor project (operator decision 2026-10-11), and the deploying
cluster owns the Secret; the chart only names it. Empty renders nothing, which
is what a public registry wants. The database pods are not included: MySQL and
ClickHouse are upstream public images, and templates/_helpers.tpl's rule that
their pod templates never move with the release stands.
*/}}
{{- define "wrathbench.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "wrathbench.containerSecurityContext" -}}
allowPrivilegeEscalation: false
capabilities:
  drop: [ALL]
{{- end -}}

{{/*
The database connection env every WrathBench-side tool needs (bootstrap,
fixtures, the smokes that stage a fixture). The password comes from the
Secret by reference; it is never templated into a manifest and never reaches
argv. The snippet sandbox forwards only a named list of variables to its child
(runner/src/sandbox/host.ts sandboxChildEnv), and none of these is on it, which
is what keeps a model off the database on the fleet and runner pods alike.
*/}}
{{- define "wrathbench.dbEnv" -}}
- name: WRATHBENCH_DB_HOST
  value: {{ include "wrathbench.fullname" . }}-db
- name: WRATHBENCH_DB_PORT
  value: "3306"
- name: WRATHBENCH_DB_USER
  value: root
- name: WRATHBENCH_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.envSecretName }}
      key: WRATHBENCH_DB_ROOT_PASSWORD
{{- end -}}

{{/*
The same password as MYSQL_PWD, which the stock mysql clients read when no
password is given on the command line: `-p<password>` would put it in the
client's argv, readable in the pod's process list. Only for a container that
runs nothing but a client — the mysql server image's own first-boot init
connects with no password and would pick this up.
*/}}
{{- define "wrathbench.mysqlPwdEnv" -}}
- name: MYSQL_PWD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.envSecretName }}
      key: WRATHBENCH_DB_ROOT_PASSWORD
{{- end -}}

{{/*
AzerothCore's three database DSNs. `AC_*` env wins over the parsed .conf
(Config.cpp GetValueDefault checks the env var first), which is why the
generated files under etc/ stay stock and everything we care about is pinned
here — same posture as infra/compose.yml.

The password is interpolated by the CONTAINER's shell from an env var sourced
from the Secret, not by Helm: the manifest carries $(WRATHBENCH_DB_PASSWORD),
which the kubelet expands from the container's own environment. No secret value
appears in the rendered chart, in `helm get manifest`, or in Flux's diff.
*/}}
{{- define "wrathbench.acDbEnv" -}}
{{ include "wrathbench.dbEnv" . }}
- name: AC_LOGIN_DATABASE_INFO
  value: "$(WRATHBENCH_DB_HOST);3306;root;$(WRATHBENCH_DB_PASSWORD);acore_auth"
- name: AC_WORLD_DATABASE_INFO
  value: "$(WRATHBENCH_DB_HOST);3306;root;$(WRATHBENCH_DB_PASSWORD);acore_world"
- name: AC_CHARACTER_DATABASE_INFO
  value: "$(WRATHBENCH_DB_HOST);3306;root;$(WRATHBENCH_DB_PASSWORD);acore_characters"
{{- end -}}

{{/*
The credentials the harness reads out of `.env` under compose, as env from the
Secret. This is env and not a mounted
`.env` file: Bun's autoload existed to keep secrets off argv, and env from a
Secret does that at least as well, while the snippet child is protected by
three independent things that do not depend on the file — sandboxChildEnv's
allowlist, `bun --env-file=/dev/null`, and the Landlock ruleset.

NAMED KEYS, NOT `envFrom` ON THE WHOLE SECRET. Every child the runner starts
gets an allowlist rather than this environment (sandboxChildEnv's named list
for the snippet child, each CLI driver's childEnv), so nothing here reaches a
model's process; enumerating keeps the pods' own environment to what they use
as well — `envFrom` would hand the fleet `WRATHBENCH_ACCOUNT_PASSWORD` and every
other key in the Secret, which nothing on these pods reads.
*/}}
{{- define "wrathbench.harnessSecretEnv" -}}
- name: WRATHBENCH_MODULE_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.envSecretName }}
      key: WRATHBENCH_MODULE_SECRET
{{- /* optional: a lane whose key is absent fails its own preflight with a
       clear message rather than wedging the pod in CreateContainerConfigError. */}}
{{- range .Values.modelKeys }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $.Values.envSecretName }}
      key: {{ . }}
      optional: true
{{- end }}
{{- end -}}

{{/* The publisher holds one credential pair, scoped to one bucket, and no
model key at all. */}}
{{- define "wrathbench.publisherSecretEnv" -}}
{{- range (list "S3_ACCESS_KEY_ID" "S3_SECRET_ACCESS_KEY" "S3_BUCKET" "S3_ENDPOINT") }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $.Values.envSecretName }}
      key: {{ . }}
{{- end }}
{{- end -}}

{{/* What one EPISODE needs from its environment: the harness stamp on every
trajectory (one string with the image tag, so a run says which revision
produced it), the module, the runs directory, and the self-hosted model
hosts. This is the whole of what run.ts reads from the chart, so it is also
the env of a run pod (templates/run-pods.yaml), where the launcher overwrites
the stamp with the arm's own image tag. The config store is deliberately NOT
here: run.ts never opens it, and a run pod mounts no config. */}}
{{- define "wrathbench.runEnv" -}}
- name: WRATHBENCH_HARNESS_VERSION
  value: {{ include "wrathbench.tag" . | quote }}
- name: WRATHBENCH_MODULE_URL
  value: "http://worldserver:8086"
- name: WRATHBENCH_RUNS_DIR
  value: /wrathbench/data/runs
{{- /* The self-hosted model hosts the provider table pairs with LMSTUDIO_KEY
       (runner/src/providers.ts). In the run env, so through harnessEnv every
       pod that parses the store gets it too: each must reach the same verdict
       on an entry — the viewer refusing a write the supervisor would accept,
       or the reverse, is the disagreement the store exists to rule out — and
       run.ts, in a run pod as in the fleet's child, checks the pair again
       before it reads the key. A plain value, so the launcher keeps it. */}}
- name: WRATHBENCH_LOCAL_MODEL_HOSTS
  value: {{ join "," (.Values.localModelHosts | default list) | quote }}
{{- end -}}

{{/* The run env plus the config store: every long-lived pod that reads the fleet config. */}}
{{- define "wrathbench.harnessEnv" -}}
{{ include "wrathbench.runEnv" . }}
{{- /* The config store (docs/RUNBOOK.md "Where the config lives"), the
       only fleet config. Set here and not per pod because every pod that
       reads config must read the SAME file: the supervisor re-reads it, the
       viewer serves and edits it, the publisher renders the viewer's roster
       from it, and the runner pod is where `config-store.ts` is exec'd (the
       one-time seed, and the deploy window's preflight read). So every pod
       that includes this block ALSO mounts the `config` subPath of the data
       PVC at this path, writable — a read-only sqlite handle still creates
       the -wal/-shm sidecars, so a readOnly mount would turn every config
       read into an error. */}}
- name: WRATHBENCH_CONFIG_DB
  value: /wrathbench/data/config/config.sqlite
{{- end -}}

{{/*
The derived store's coordinates, for every pod that reads or writes it: the
collector, the viewer and the publisher. The password comes from the Secret by
reference and never reaches a manifest or argv, the same way the database
password does.
*/}}
{{- define "wrathbench.clickhouseEnv" -}}
- name: CLICKHOUSE_URL
  value: "http://{{ include "wrathbench.fullname" . }}-clickhouse:8123"
- name: CLICKHOUSE_DATABASE
  value: {{ .Values.clickhouse.database | quote }}
- name: CLICKHOUSE_USER
  value: {{ .Values.clickhouse.user | quote }}
- name: CLICKHOUSE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.envSecretName }}
      key: CLICKHOUSE_PASSWORD
{{- end -}}
