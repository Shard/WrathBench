# Runner service image: Bun (pinned), git, the Claude Code CLI for the
# claude-subscription shakeout driver, and the repository itself baked in (the
# cluster has no bind mount to supply it).
#
# git is here for one reason: the fleet supervisor runs INSIDE this image
# (the fleet container), and on the quickstart it stamps every episode with
# `git describe` off the bind-mounted repo, exactly as infra/run-episode.sh
# does on the host. Without it a containerised supervisor would have to trust a
# stamp written at `up` time, which goes stale the moment a tracked file is
# edited — a dirty tree would stamp clean. The CLI is the native binary from
# Anthropic's installer, PINNED below: a new model can require a newer CLI,
# and an unpinned install is a cached layer, so a rebuild for that reason
# would ship the old binary again. Bumping the pin is what busts the cache.
# Shakeout runs are never scored, so CLI drift cannot contaminate results
# (see runner/README.md Drivers).
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
FROM oven/bun:1.4.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git tini fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# fonts-dejavu-core is the publisher's, not the fleet's. The publisher runs
# this image and renders the social card (infra/og-render.ts), and resvg
# resolves a font family through the host's font database and draws NOTHING at
# all when it matches none — no error, no fallback box. The base image carries
# no fonts, so without this the card would publish with its wordmark, its axis
# captions and every model name silently missing. ~1 MB, and DejaVu Sans Mono
# is what the card's stack (the site's own monospace face) falls back to.

# tini is compose's `init: true` for the Kubernetes fleet pod: an episode can
# leave orphaned grandchildren, and bun as pid 1 would not reap them. Compose
# gets its init from the runtime; the chart runs `tini -- bun infra/run-fleet.ts`.

# The base image ships a `bun` user at uid 1000; install the CLI as that user,
# the same uid the compose service and the Kubernetes pods run with.
USER bun
ENV HOME=/home/bun
# 2.1.309 was probed on a subscription lane before it was pinned. The aliases opus,
# sonnet, haiku and fable resolve to the same models as on 2.1.293, and they and
# the claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1 and
# claude-fable-5 ids report the real 1M context window in `modelUsage`, not the
# 200k fallback for an unrecognized model. The driver's stream-json flag set was
# run against a stub MCP server, and a compaction record was checked.
# 2.1.304 is the first CLI that reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n>k` as
# written, per its changelog; 2.1.293 read `200k` and `300k` as 100k (probed).
ARG CLAUDE_CODE_VERSION=2.1.309
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}" \
    && /home/bun/.local/bin/claude --version
# The OpenAI Codex CLI for the `codex` driver (runner/README.md, Drivers),
# PINNED: the driver's flag set and feature names are checked against exactly
# this version (`codex exec --help`, `codex exec resume --help`, `codex features
# list`), and an unknown `--disable` name is a launch error. A newer model needs
# a CLI whose bundled catalogue knows it: an older one runs it on fallback
# metadata ("Model metadata for ... not found"). Bumping the ARG is also what
# busts the cached layer.
#
# Why the platform package and not `@openai/codex`: the wrapper package ships
# nothing but `bin/codex.js`, a shim with a `node` shebang that re-execs the
# native binary out of an optional platform dependency — and there is no node in
# this image. `bun add -g` does not help either: bun's global bin directory here
# is /usr/local/bin, which uid 1000 cannot write, so the link fails EACCES.
# `@openai/codex@<version>-linux-x64` IS the vendor
# payload — a statically linked musl binary plus the codex-resources it locates
# relative to itself — so installing that one package and symlinking its binary
# onto PATH is the smallest thing that produces a working `codex`, with no node,
# no npm and no shim in the path. The whole vendor tree is kept: the binary
# resolves its own path, so the symlink is transparent.
ARG CODEX_VERSION=0.163.0
RUN mkdir -p /home/bun/codex-cli \
    && cd /home/bun/codex-cli \
    && bun add "@openai/codex@${CODEX_VERSION}-linux-x64" \
    && ln -s /home/bun/codex-cli/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex \
             /home/bun/.local/bin/codex \
    && /home/bun/.local/bin/codex --version
# The pi coding-agent CLI for the `pi` driver (runner/README.md, "The pi
# driver"; GitHub issue #257), PINNED by version and by the release tarball's
# sha256 from that release's SHA256SUMS. The driver was written against 1.3.0,
# and 1.4.0 replaced it. pi releases several times a week. The driver's flags
# (`--mode rpc`, `--no-builtin-tools`, `--tools`, `--no-extensions -e
# builtin:mcp`, `--offline`), its RPC event shapes, its settings keys
# (`compaction.reserveTokens`, `enableInstallTelemetry`, `cacheWarming`) and
# the `before_agent_start` prompt override (runner/src/pi-extension.ts) were
# read off the source, re-read across the 1.3.0..1.4.0 diff, and checked
# against this binary over a stub endpoint in a loopback-only network
# namespace. The checks: our prompt bytes exactly, only our nine tools, the
# prompt-missing path sending nothing, and no outbound attempt with the
# phone-home switches on but three without them. Why the release tarball and not npm: the npm package is a node
# script (`#!/usr/bin/env node`, node >= 22.19) and this image's only `node`
# is Bun's fallback shim; the release ships pi as one Bun-compiled glibc
# binary (checked to run in oven/bun:1.4.4, glibc 2.41) with the
# assets it reads beside it (themes, the photon wasm, docs), so the whole
# directory is kept and the binary symlinked onto PATH. Bumping the ARGs
# busts the cached layer; a bump is a deliberate change, re-verified.
ARG PI_VERSION=1.4.0
ARG PI_SHA256=f2e4e4329603223d03260cdb8bd5033dbdc1f73ba58ab8939db2e56546e115d2
RUN mkdir -p /home/bun/pi-cli \
    && cd /home/bun/pi-cli \
    && curl -fsSLo pi.tar.gz "https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-x64.tar.gz" \
    && echo "${PI_SHA256}  pi.tar.gz" | sha256sum -c - \
    && tar xzf pi.tar.gz \
    && rm pi.tar.gz \
    && ln -s /home/bun/pi-cli/pi/pi /home/bun/.local/bin/pi \
    && PI_OFFLINE=1 PI_TELEMETRY=0 /home/bun/.local/bin/pi --version
ENV PATH="/home/bun/.local/bin:${PATH}"

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
COPY --chown=1000:1000 collector/package.json collector/package.json
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
