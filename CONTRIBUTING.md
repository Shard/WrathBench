# Contributing

WrathBench is early: the control surface exists and models fly, and the shape of everything above it is still moving. Issues and
discussion are welcome — a question about why something is the way it is, a
bug, an observation from reading the code, all of it. Open a pull request only
against an issue that already exists and that someone has agreed on, and keep
it small. That is not gatekeeping for its own sake; it is that most of this
repository encodes decisions whose reasons are written down elsewhere, and a
patch that has not met the reason tends to undo it.

## The hard constraints

These are from `CLAUDE.md` and they hold for every change:

- Nothing Blizzard-derived ever enters git: no client files, no MPQ/DBC, no
  extracted maps/vmaps/mmaps, no wiki dumps containing game text, no trajectory
  logs.
- The agent observes only what a real game client could observe, and the action
  path goes through the same server opcode handlers a client would hit
  (`wrath-mcp/docs/CONTRACTS.md`). If you find yourself reaching for a server-side
  shortcut that a client could not do, that is the signal to stop.
- The C++ module stays thin: packet bridge and event tap only. Game semantics
  live in TypeScript (a rule of the stack's, kept in wrath-mcp).
- The agent loop is model-agnostic. No per-model prompts, retries, or tuning.
- SDK helpers are earned by observed need in trajectories, never speculative;
  the raw-action escape hatch is how a trajectory shows the need first
  (`docs/METHODOLOGY.md`, "The model surface").

## Licence

Inbound equals outbound: what you contribute here is MIT under the root
`LICENSE`. There is no CLA and no DCO sign-off. Opening the pull request is the
grant. A contribution to the stack is made in wrath-mcp, under the terms its
README states.

## The stack is another repository

The agent stack (the AzerothCore module, the SDK, the MCP server and snippet
sandbox) is [Shard/wrath-mcp](https://github.com/Shard/wrath-mcp), checked out
here as the `wrath-mcp/` submodule. A change to it goes to wrath-mcp first, as
an issue and a pull request there under its own `CONTRIBUTING.md`. Once that
merges, a pull request here moves the submodule pointer to the new wrath-mcp
commit, which is what puts the change into WrathBench's builds
(`infra/PINS.md` has the rules). A change that needs both sides is two pull
requests, the stack's merged first.

A module change cannot be verified by either repository's CI: the module
compiles only inside an AzerothCore tree and is exercised only by a live
worldserver. It is verified by the release that carries the pointer bump,
which builds the worldserver image with it, and the smoke suite run against
the live stack after that release.

## Model results

Results from outside the operator's fleet are not accepted yet, and issue #31
keeps community submissions out of scope. The reason is what a result is here:
a claim of the form "harness vX, model Y, episode Z", valid only inside its comparability group, standing on the
module-boundary audit log that proves the observation and action contracts held
for that run (`docs/METHODOLOGY.md`). A number produced on someone else's
harness has no such evidence behind it, and putting it on the same axis would
quietly break the one property the ladder has. When there is a way to accept
outside runs without losing it, that will be its own decision.

## Running the tests

From a clone with the stack's submodule checked out (`git clone
--recurse-submodules`, or `git submodule update --init wrath-mcp` after a plain
clone), with no `data/` directory and no game data of any kind:
`bun install --frozen-lockfile` once at the root (Bun 1.4.x, pinned in
`.bun-version`), then `bun run test` for every workspace's suite and
`bun run typecheck` for every project. Run both — Bun strips types without
checking them, so a green test run says nothing about types. CI additionally
runs `bun run boundary` and `bun run dashboard:build`, which are cheap locally
and worth running before you push. The smoke scripts in `infra/smoke/` need the
live stack and therefore cannot run in CI or on a bare clone.

## Where a change is written down

Describe the change in the pull request itself — what it does and why, against
the issue it lands on. Decisions go in `docs/METHODOLOGY.md` or in the doc that
owns the component; methodological decisions are the operator's alone, so a
pull request never changes one — if your work would contradict one, say so in
the issue instead.
