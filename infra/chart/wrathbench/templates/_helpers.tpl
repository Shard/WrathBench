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
strings are built here. The cluster repo's restic CronJob runs mysqldump
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

{{/* The immutable tag, validated. */}}
{{- define "wrathbench.tag" -}}
{{- $t := required "image.tag is required: the immutable tag (`git describe` of the source SHA) that this release deploys. See GitHub issue 7 — no mutable default may become the deployment source." .Values.image.tag | toString -}}
{{- if or (eq $t "") (eq $t "latest") -}}
{{- fail "image.tag must be an immutable tag; \"\" and \"latest\" are refused — see GitHub issue 7" -}}
{{- end -}}
{{- $t -}}
{{- end -}}

{{- define "wrathbench.image.worldserver" -}}
{{ .Values.image.registry }}/{{ .Values.image.names.worldserver }}:{{ include "wrathbench.tag" . }}
{{- end -}}
{{- define "wrathbench.image.authserver" -}}
{{ .Values.image.registry }}/{{ .Values.image.names.authserver }}:{{ include "wrathbench.tag" . }}
{{- end -}}
{{- define "wrathbench.image.dbImport" -}}
{{ .Values.image.registry }}/{{ .Values.image.names.dbImport }}:{{ include "wrathbench.tag" . }}
{{- end -}}
{{- define "wrathbench.image.runner" -}}
{{ .Values.image.registry }}/{{ .Values.image.names.runner }}:{{ include "wrathbench.tag" . }}
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
  # Verified 2026-09-05 on chungusjr (kernel 6.13, containerd 2.2, Landlock ABI
  # 6): containerd's RuntimeDefault profile permits landlock_create_ruleset /
  # landlock_add_rule / landlock_restrict_self, so the snippet sandbox's
  # confinement (runner/src/sandbox/confine.ts) still applies. If that ever
  # stops being true the wrapper fails closed and no snippet runs at all.
  type: RuntimeDefault
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
argv. The snippet sandbox strips every WRATHBENCH_DB_* var before spawning the
child (runner/src/sandbox/host.ts sandboxChildEnv), which is what keeps a model
off the database on the fleet and runner pods alike.
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
Secret. See docs/DEPLOY-NUSPHERE.md for why this is env and not a mounted
`.env` file: Bun's autoload existed to keep secrets off argv, and env from a
Secret does that at least as well, while the snippet child is protected by
three independent things that do not depend on the file — sandboxChildEnv's
allowlist, `bun --env-file=/dev/null`, and the Landlock ruleset.

NAMED KEYS, NOT `envFrom` ON THE WHOLE SECRET, and the difference matters.
sandboxChildEnv forwards every `WRATHBENCH_*` variable to the snippet child
except `WRATHBENCH_DB_*` and the module secret — that allowlist is written
against what the fleet process actually holds. `envFrom` would hand the pod
`WRATHBENCH_ACCOUNT_PASSWORD` (which the compose fleet never has: it is not in
`.env`, only on the bootstrap service), and the allowlist would forward it
straight into a model's sandbox. Enumerating is what keeps the pod's
environment the same shape the allowlist was designed for.

The model keys themselves are not `WRATHBENCH_*`, so the child never sees them.
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

{{/* The harness stamp on every trajectory. One string with the image tag and
the worldserver's /health build, so a run says which revision produced it. */}}
{{- define "wrathbench.harnessEnv" -}}
- name: WRATHBENCH_HARNESS_VERSION
  value: {{ include "wrathbench.tag" . | quote }}
- name: WRATHBENCH_MODULE_URL
  value: "http://worldserver:8086"
- name: WRATHBENCH_RUNS_DIR
  value: /wrathbench/data/runs
{{- /* The config store (docs/OPERATIONS.md "Where the config lives"), the
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
