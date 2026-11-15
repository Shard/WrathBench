{{/*
The camera (values.yaml `camera`; docs/RUNBOOK.md, "Camera"): two sidecar
containers in a world's pod. `camera` is the camera client image, headless,
logged in as the CAMERA GM account; `camera-director` is the runner image
running infra/camera/director.ts, which drives it over the client's
loopback-only control port and writes the run's `camera/` directory.

In the pod because every realm row advertises 127.0.0.1:8085: a client
elsewhere would be handed its own loopback. Its only connections are the
authserver (in-namespace, which the namespace's policy admits) and its own
pod's world port over loopback, so no NetworkPolicy of the chart's needs a
rule for it: the world and worldserver policies are ingress-only.

The shared world's Deployment carries it whenever the block is on. A world
per eval's template carries it too, with no realm or world of its own: the
launcher (infra/world.ts `buildWorldPod`) stamps those when the world takes
a camera slot (`maxConcurrent`, the shared world's camera counted) and strips
both containers and their volumes when it does not, so a world without a slot
claims no GPU and no camera resources.

Called with (dict "ctx" . "world" <bool>).
*/}}
{{- define "wrathbench.camera.containers" -}}
{{- $ctx := .ctx -}}
{{- $world := .world -}}
{{- $c := $ctx.Values.camera -}}
{{- $gpu := eq $c.renderer "gpu" -}}
- name: camera
  image: {{ required "camera.image is required when camera.enabled" $c.image }}
  imagePullPolicy: {{ $ctx.Values.image.pullPolicy }}
  securityContext: {{- include "wrathbench.containerSecurityContext" $ctx | nindent 4 }}
  env:
    # The realm the client picks by name: the shared world's here; a world's
    # (`WrathBench <id>`) is the launcher's to stamp.
    - name: CAMERA_REALM
      value: {{ if $world }}""{{ else }}{{ $ctx.Values.realm.name | quote }}{{ end }}
    - name: CAMERA_AUTH
      value: "authserver:3724"
    - name: CAMERA_ACCOUNT
      value: {{ $c.account | quote }}
    # From the Secret, never argv: the client reads it by name
    # (`--password-env`).
    - name: CAMERA_PASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ $ctx.Values.envSecretName }}
          key: {{ $c.passwordKey }}
    - name: CAMERA_RUN_DIR
      value: /run/camera
    - name: CAMERA_PORT
      value: "17980"
    - name: CAMERA_FPS
      value: {{ ternary "5" "2" $gpu | quote }}
    - name: WRATHPLUS_HOME
      value: /run/camera/home
    - name: WOW_DATA
      value: /data/client
    # Noon on the camera's own clock: the scene's light only, client-side.
    # The world's game time, which the agents see, is untouched.
    - name: WOW_CLOCK
      value: "720"
    {{- if not $gpu }}
    # Mesa's software Vulkan (lavapipe): no GPU claim.
    - name: VK_ICD_FILENAMES
      value: /usr/share/vulkan/icd.d/lvp_icd.x86_64.json
    {{- end }}
  resources: {{ toYaml (ternary $c.resources.gpu $c.resources.software $gpu) | nindent 4 }}
  volumeMounts:
    - name: camera-run
      mountPath: /run/camera
    # The client's 3.3.5a Data folder (MPQs), operator-supplied, read-only,
    # never in git or an image.
    - name: camera-client-data
      mountPath: /data/client
      subPath: {{ $c.clientData.subPath }}
      readOnly: true
- name: camera-director
  image: {{ include "wrathbench.image.runner" $ctx }}
  imagePullPolicy: {{ $ctx.Values.image.pullPolicy }}
  securityContext: {{- include "wrathbench.containerSecurityContext" $ctx | nindent 4 }}
  workingDir: /wrathbench
  command: ["/usr/bin/tini", "--", "bun", "infra/camera/director.ts"]
  env:
    - name: CAMERA_WORLD
      value: {{ if $world }}""{{ else }}"shared"{{ end }}
    - name: CAMERA_INTERVAL_SECONDS
      value: {{ $c.intervalSeconds | quote }}
    - name: CAMERA_RUN_DIR
      value: /run/camera
    - name: CAMERA_PORT
      value: "17980"
    - name: CAMERA_RUNS_DIR
      value: /wrathbench/data/runs
  resources: {{ toYaml $c.director.resources | nindent 4 }}
  volumeMounts:
    - name: camera-run
      mountPath: /run/camera
      readOnly: true
    # The runs tree: the director reads the subject's session and
    # trajectory and writes only its `camera/` directory and meta.json's
    # `camera` label.
    - name: data
      mountPath: /wrathbench/data/runs
      subPath: runs
{{- end -}}

{{- define "wrathbench.camera.volumes" -}}
- name: camera-run
  emptyDir:
    sizeLimit: 2Gi
- name: camera-client-data
  persistentVolumeClaim:
    claimName: {{ required "camera.clientData.claimName is required when camera.enabled" .Values.camera.clientData.claimName }}
    readOnly: true
{{- end -}}

{{/* The world's own GM settings: a camera is a GM, invisible from the moment it loads, before it is on the map. Harness accounts never carry GM, so no other session is touched. */}}
{{- define "wrathbench.camera.worldEnv" -}}
{{- if .Values.camera.enabled }}
- name: AC_GM_LOGIN_STATE
  value: "1"
- name: AC_GM_VISIBLE
  value: "0"
{{- end }}
{{- end -}}
