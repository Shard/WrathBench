{{/*
The camera (values.yaml `camera`; docs/RUNBOOK.md, "Camera"): a pod of its
own per filmed world, never a container in a world's pod. Two containers:
`camera`, the camera client image, headless, logged in as the CAMERA GM
account; and `camera-director`, the runner image running
infra/camera/director.ts, which drives it over the client's loopback-only
control port and writes the run's `camera/` directory.

Every realm row advertises 127.0.0.1:8085, so the director also listens there
and forwards to the world it films (`--forward-world`, infra/camera/forward.ts):
the client, handed its own loopback, reaches the world's port through it. The
world policies admit 8085 from every source and the authserver is
in-namespace, so no NetworkPolicy of the chart's needs a rule for it.

This is the TEMPLATE only, rendered into the fleet's template ConfigMap as
`camera.json` (templates/run-pods.yaml). Nothing in the release creates a
camera, so a broken camera image, claim or crash can never hold a world's pod
short of Ready or a release's rollout: the fleet makes the shared world's
camera (infra/camera-pods.ts `ensureSharedCamera`) and the world launcher a
world's, after the world is up (`startWorldCamera`), each only while a slot is
free (`maxConcurrent`; the shared world's always held for it). The launcher
fills in the realm, the world, the forward target, the name and the owner. A
world's camera is owned by the world's pod, so it goes with it, after it,
never holding it up; the shared one by the fleet pod.
*/}}
{{- define "wrathbench.cameraPodTemplate" -}}
{{- $c := .Values.camera -}}
{{- $gpu := eq $c.renderer "gpu" -}}
apiVersion: v1
kind: Pod
metadata:
  generateName: {{ include "wrathbench.fullname" . }}-camera-
  labels:
    app.kubernetes.io/name: {{ include "wrathbench.name" . }}
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/component: camera
    {{- with .Values.podLabels }}{{ toYaml . | nindent 4 }}{{ end }}
  annotations:
    {{- with .Values.podAnnotations }}{{ toYaml . | nindent 4 }}{{ end }}
    # How many cameras may run at once, the shared world's among them.
    wrathbench.shard.page/camera-max: {{ $c.maxConcurrent | quote }}
    # The shared world's realm, which its camera picks by name.
    wrathbench.shard.page/shared-realm: {{ .Values.realm.name | quote }}
    kubectl.kubernetes.io/default-container: camera-director
spec:
  # A camera that falls over comes back in place; its world's end removes it.
  restartPolicy: Always
  automountServiceAccountToken: false
  {{- with .Values.priorityClassName }}
  priorityClassName: {{ . }}
  {{- end }}
  nodeSelector: {{ toYaml .Values.nodeSelector | nindent 4 }}
  securityContext: {{- include "wrathbench.podSecurityContext" . | nindent 4 }}
  {{- include "wrathbench.imagePullSecrets" . | nindent 2 }}
  # Time for the director to keep the frames its ring holds when the pod goes.
  terminationGracePeriodSeconds: 30
  containers:
    - name: camera
      image: {{ required "camera.image is required when camera.enabled" $c.image }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext: {{- include "wrathbench.containerSecurityContext" . | nindent 8 }}
      env:
        # The realm the client picks by name: the launcher's to stamp.
        - name: CAMERA_REALM
          value: ""
        - name: CAMERA_AUTH
          value: "authserver:3724"
        - name: CAMERA_ACCOUNT
          value: {{ $c.account | quote }}
        # From the Secret, never argv: the client reads it by name.
        - name: CAMERA_PASSWORD
          valueFrom:
            secretKeyRef:
              name: {{ .Values.envSecretName }}
              key: {{ $c.passwordKey }}
        - name: CAMERA_RUN_DIR
          value: /run/camera
        - name: CAMERA_PORT
          value: "17980"
        - name: CAMERA_FPS
          value: {{ ternary "5" "2" $gpu | quote }}
        - name: WOW_DATA
          value: /data/client
        # Noon on the camera's own clock: the scene's light only, client-side.
        # The world's game time, which the agents see, is untouched.
        - name: WOW_CLOCK
          value: "720"
        {{- if not $gpu }}
        # Mesa's software Vulkan (lavapipe): no GPU claim.
        - name: VK_ICD_FILENAMES
          value: /usr/share/vulkan/icd.d/lvp_icd.json
        {{- end }}
      resources: {{ toYaml (ternary $c.resources.gpu $c.resources.software $gpu) | nindent 8 }}
      volumeMounts:
        - name: camera-run
          mountPath: /run/camera
        # The client's 3.3.5a Data folder (MPQs), operator-supplied,
        # read-only, never in git or an image.
        - name: camera-client-data
          mountPath: /data/client
          subPath: {{ $c.clientData.subPath }}
          readOnly: true
    - name: camera-director
      image: {{ include "wrathbench.image.runner" . }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext: {{- include "wrathbench.containerSecurityContext" . | nindent 8 }}
      workingDir: /wrathbench
      # The launcher appends `--forward-world <host>:8085`.
      command: ["/usr/bin/tini", "--", "bun", "infra/camera/director.ts"]
      env:
        # The world it films, a world id or `shared`: the launcher's to stamp.
        - name: CAMERA_WORLD
          value: ""
        - name: CAMERA_INTERVAL_SECONDS
          value: {{ $c.intervalSeconds | quote }}
        - name: CAMERA_RUN_DIR
          value: /run/camera
        - name: CAMERA_PORT
          value: "17980"
        - name: CAMERA_RUNS_DIR
          value: /wrathbench/data/runs
      resources: {{ toYaml $c.director.resources | nindent 8 }}
      volumeMounts:
        - name: camera-run
          mountPath: /run/camera
          readOnly: true
        # The runs tree: the director reads the subject's session and
        # trajectory and writes only its `camera/` directory.
        - name: data
          mountPath: /wrathbench/data/runs
          subPath: runs
  volumes:
    - name: camera-run
      emptyDir:
        sizeLimit: 256Mi
    - name: camera-client-data
      persistentVolumeClaim:
        claimName: {{ required "camera.clientData.claimName is required when camera.enabled" $c.clientData.claimName }}
        readOnly: true
    - name: data
      persistentVolumeClaim:
        claimName: {{ include "wrathbench.fullname" . }}-data
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
