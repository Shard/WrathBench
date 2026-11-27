# Viewer-only image: Bun (pinned), the workspace's TypeScript and the built
# dashboard, and nothing else. It runs `viewer/serve.ts` over a session
# store someone else's wrath-mcp records into, with no runner, no game server
# and no ClickHouse beside it (infra/compose.viewer.yml, infra/README.md
# "Viewer only"). No model CLIs, no git, no ffmpeg: the runner image
# (runner.Dockerfile) carries those for the fleet, the camera and the
# publisher, and a viewer uses none of them.
#
# The build context is the repository root with the wrath-mcp submodule
# checked out (`git submodule update --init wrath-mcp`); the ignore list is
# infra/docker/viewer.Dockerfile.dockerignore, which BuildKit prefers over the
# root one. Nothing under data/ and no .env enters the image.

# The dashboard is built with the whole workspace's dev dependencies (Vite,
# Solid's compiler); the image that serves it keeps only what runs.
FROM oven/bun:1.4.4 AS build
WORKDIR /wrathbench
# Every workspace the root package.json lists needs its manifest before a
# frozen install (infra/image-context.test.ts).
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY wrath-mcp/sdk/package.json wrath-mcp/sdk/package.json
COPY wrath-mcp/mcp/package.json wrath-mcp/mcp/package.json
COPY wrath-mcp/inspector/package.json wrath-mcp/inspector/package.json
COPY runner/package.json    runner/package.json
COPY viewer/package.json    viewer/package.json
COPY wiki/package.json      wiki/package.json
COPY minimap/package.json   minimap/package.json
COPY dashboard/package.json dashboard/package.json
COPY collector/package.json collector/package.json
RUN bun install --frozen-lockfile
COPY . .
# The private viewer's build, not the public snapshot's (docs/PUBLIC-DASHBOARD.md).
RUN bun run --cwd dashboard build

FROM oven/bun:1.4.4
WORKDIR /wrathbench
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY wrath-mcp/sdk/package.json wrath-mcp/sdk/package.json
COPY wrath-mcp/mcp/package.json wrath-mcp/mcp/package.json
COPY wrath-mcp/inspector/package.json wrath-mcp/inspector/package.json
COPY runner/package.json    runner/package.json
COPY viewer/package.json    viewer/package.json
COPY wiki/package.json      wiki/package.json
COPY minimap/package.json   minimap/package.json
COPY dashboard/package.json dashboard/package.json
COPY collector/package.json collector/package.json
RUN bun install --frozen-lockfile --production
COPY . .
COPY --from=build /wrathbench/dashboard/dist dashboard/dist

# An empty runs directory, readable by whatever uid the container runs as:
# compose sets `user:` to the uid that owns the session store, and the viewer
# would otherwise try to create its default runs directory under a tree that
# uid cannot write. Outside data/, which never enters an image.
RUN mkdir -p /var/lib/wrathbench/runs && chmod 0755 /var/lib/wrathbench /var/lib/wrathbench/runs
ENV WRATHBENCH_RUNS_DIR=/var/lib/wrathbench/runs \
    WRATHBENCH_DATA=/var/lib/wrathbench \
    WRATHBENCH_GROUPS=viewer

# No `.env` is read, wherever one might appear: Bun autoloads one from the
# working directory, and a viewer's configuration is its environment alone.
CMD ["bun", "--no-env-file", "viewer/serve.ts"]
