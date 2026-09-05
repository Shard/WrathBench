# Runner service image: Bun (pinned), git, the Claude Code CLI for the
# claude-subscription shakeout driver, and — since the Kubernetes work
# (2026-09-05) — the repository itself baked in.
#
# git is here for one reason: the fleet supervisor runs INSIDE this image
# (compose service `fleet`) and stamps every episode with
# `git describe` off the bind-mounted repo, exactly as infra/run-episode.sh
# does on the host. Without it a containerised supervisor would have to trust a
# stamp written at `up` time, which goes stale the moment a tracked file is
# edited — a dirty tree would stamp clean. The CLI is the native binary from
# Anthropic's installer; its version is recorded at build time in the image
# (claude --version) but not pinned — shakeout runs are never scored, so CLI
# drift cannot contaminate results (see runner/README.md Drivers).
#
# Why the repo is baked in
# ------------------------
# Under compose the repo arrives as a bind mount and the image is a runtime.
# On Kubernetes there is no repo to mount: the Deployment's only source of the
# harness is the image, pinned to an immutable tag (GitHub issue 7). So the
# build COPYs the tree, installs the workspace with the pinned lockfile, and
# builds the dashboard SPA the viewer serves. Compose bind-mounts /wrathbench
# over all of it, which is harmless — the mount simply wins, exactly as before.
#
# The build context is the repository root and the ignore list for THIS file is
# infra/docker/runner.Dockerfile.dockerignore (BuildKit prefers a
# <dockerfile>.dockerignore over the root one). The root .dockerignore excludes
# runner/, sdk/, wiki/ and docs/ because the SERVER image does not want them;
# this image is nothing but them.
FROM oven/bun:1.4.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*

# tini is compose's `init: true` for the Kubernetes fleet pod: an episode can
# leave orphaned grandchildren, and bun as pid 1 would not reap them. Compose
# gets its init from the runtime; the chart runs `tini -- bun infra/run-fleet.ts`.

# The base image ships a `bun` user at uid 1000; install the CLI as that user,
# the same uid the compose service and the Kubernetes pods run with.
USER bun
ENV HOME=/home/bun
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && /home/bun/.local/bin/claude --version
# The OpenAI Codex CLI for the `codex` driver (runner/README.md, Drivers),
# PINNED: the driver's flag set, feature names and event JSONL were verified
# against exactly this version (2026-09-05), and an unknown `--disable` name is
# a launch error. There is no npm in this image, so bun's global install does
# the job; it lands in /home/bun/.bun/bin. Not yet rebuilt or verified in the
# image as of the commit that added it — see docs/FOLLOW-UPS.md.
RUN bun add -g @openai/codex@0.153.4 \
    && /home/bun/.bun/bin/codex --version
ENV PATH="/home/bun/.local/bin:/home/bun/.bun/bin:${PATH}"

WORKDIR /wrathbench

# Dependencies first, so a source edit does not re-resolve the workspace.
# `node_modules/` at the repo root is not an optional nicety: confine.ts's
# Landlock allowlist names it, so a snippet child fails closed without it.
COPY --chown=1000:1000 package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY --chown=1000:1000 sdk/package.json       sdk/package.json
COPY --chown=1000:1000 runner/package.json    runner/package.json
COPY --chown=1000:1000 wiki/package.json      wiki/package.json
COPY --chown=1000:1000 minimap/package.json   minimap/package.json
COPY --chown=1000:1000 dashboard/package.json dashboard/package.json
RUN bun install --frozen-lockfile

COPY --chown=1000:1000 . .

# The operator viewer serves the built SPA out of dashboard/dist, which is
# gitignored and therefore absent from the context. Build it here so the
# Kubernetes viewer serves the app rather than its "how to build it" notice.
# Deliberately NOT VITE_WRATHBENCH_PUBLIC_ORIGIN: that is the public snapshot
# build (docs/PUBLIC-DASHBOARD.md), and this is the private viewer.
RUN bun run --cwd dashboard build

# The harness stamp for a checkout with no .git — a Kubernetes pod, or a bare
# `docker run` of this image. Deliberately NOT named WRATHBENCH_HARNESS_VERSION:
# runner/src/version.ts prefers that variable over `git describe`, so baking it
# would freeze the stamp of a compose fleet that has the live repo mounted. The
# chart sets WRATHBENCH_HARNESS_VERSION from image.tag on the pods instead, so
# it also reaches `kubectl exec` (which never runs an entrypoint).
ARG WRATHBENCH_BUILD_VERSION=""
ENV WRATHBENCH_BUILD_VERSION="${WRATHBENCH_BUILD_VERSION}"
LABEL wrathbench.build="${WRATHBENCH_BUILD_VERSION}"

CMD ["sleep", "infinity"]
