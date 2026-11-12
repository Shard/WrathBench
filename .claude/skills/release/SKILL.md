---
name: release
description: Releasing WrathBench to the cluster with `bun wb release` — whether a change needs a release at all, how to time it around live runs, what to do before the pin, and what to check after the resume. Use when the operator asks for a release or a deploy, when a merged change has to reach the fleet (any code, a module pointer bump, a CLI pin, a chart change), and when a release stopped part-way.
---

# Release

A release is a fleet write: an agent runs one only when the operator asked for
it (skill `fleet-readonly`). The procedure is `docs/RUNBOOK.md`, "Deploy
window", and `infra/README.md`, "Releasing on Kubernetes", which has the five
phases (build, drain, pin, deploy, resume) and the pin hook. This is what to
decide around it.

## Does it need one

Config store edits land on the next tick and campaign definitions are
published, neither with a release. Any code, the chart, a CLI pin or a
`wrath-mcp` pointer bump needs one (`docs/RUNBOOK.md`, "Updating the live
fleet", has the table). The public site's bundle ships apart, with
`bun wb site ship`.

## Before

```
bun wb release build --push        # any time, hours early: nothing rolls until the pin
bun wb fleet status                # what is live
bun wb fleet dry-run               # what would launch next
bun wb release run --dry-run       # the plan, the tag, what the cluster carries now
```

- **Time the drain.** It waits for every scored run on its own clock, so an
  `e360` that just launched holds the release for six hours. Freeplay and
  `resume: true` campaign squares park and come back in place. A campaign
  square without `resume` is waited on like a scored run, and a forced roll
  spends it: disable the campaign while the square plays, release when it has
  ended, re-enable.
- **The checkout.** The build refuses a dirty tree and a `wrath-mcp/` that
  does not hold the pinned commit: after a fast-forward,
  `git submodule update --init wrath-mcp` (and `bun install --frozen-lockfile`
  for the host-side commands that follow). The server images also need the
  pinned AzerothCore: `git submodule update --init deps/azerothcore` in a
  fresh clone or worktree, where `--reference` to another checkout's
  `deps/azerothcore` saves the clone. Build early only at the commit you
  will release: the tag is `git describe` of HEAD.
- **A chart change and the values that need it go in separate pins**, chart
  first, when a GitOps controller applies them: otherwise the old chart can
  be upgraded with the new values.

## Running it

```
bun wb release run --pin-hook <your pin hook>
bun wb release run --from <phase>            # restart where it stopped
```

- A failed pin phase leaves the fleet drained with the switch set, by design:
  fix the pin, then `--from pin`.
- Running phases by hand, chain them with `&&`, never `;`: a deploy window
  that runs after a failed pin smokes the old build and resumes on it.
- `--keep-paused` is an option, not the default, for a change that could
  break every run of a driver at launch (`docs/RUNBOOK.md`, "Holding the
  fleet for a CLI-env or sandbox change"). Otherwise the fleet resumes as
  soon as the gate passes; nothing else runs while it is held.

## After

1. `bun wb fleet status`: `server build` is the new tag, the preflight gate
   passed, and the runs that were live are live again (freeplay and parked
   squares resumed in place).
2. Watch the first real run that exercises what the release shipped (skill
   `run-forensics`), per driver if it touched a CLI's environment or the
   sandbox.
3. A module change: `bun wb smoke <name>`, or `bun wb smoke suite` after
   anything on the game surface, with the fleet live, never while it is held.
   Re-run one failed suite member as `bun wb smoke suite <member>`, which
   keeps it on its own account; the bare `bun wb smoke <name>` logs in on
   PROBE and fails at character creation on the name.
4. A publisher change: `bun wb site verify` after the new publisher's first
   pass, from a checkout at the released commit, since the verifier is this
   checkout's code.

A smoke that fails after the resume found a defect in a live build: tell the
operator; reverting the pin is another release.
