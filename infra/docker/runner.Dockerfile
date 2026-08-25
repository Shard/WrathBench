# Runner service image: Bun (pinned), git, plus the Claude Code CLI for the
# claude-subscription shakeout driver.
#
# git is here for one reason: the fleet supervisor now runs INSIDE this image
# (compose service `fleet`) and stamps every episode with
# `git describe` off the bind-mounted repo, exactly as infra/run-episode.sh
# does on the host. Without it a containerised supervisor would have to trust a
# stamp written at `up` time, which goes stale the moment a tracked file is
# edited — a dirty tree would stamp clean. The CLI is the native binary from
# Anthropic's installer; its version is recorded at build time in the image
# (claude --version) but not pinned — shakeout runs are never scored, so CLI
# drift cannot contaminate results (see runner/README.md Drivers).
FROM oven/bun:1.4.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# The base image ships a `bun` user at uid 1000; install the CLI as that user,
# the same uid the compose service runs with.
USER bun
ENV HOME=/home/bun
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && /home/bun/.local/bin/claude --version
ENV PATH="/home/bun/.local/bin:${PATH}"

WORKDIR /wrathbench
CMD ["sleep", "infinity"]
