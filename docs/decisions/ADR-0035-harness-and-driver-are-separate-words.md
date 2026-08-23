# ADR-0035: Harness and driver are separate words

Status: Accepted. Date: 2026-08-23. Supersedes the "shakeout-only (external
scaffold)" rule for the Claude Code path as it was stated in ADR-0004's
consequences, ADR-0012's scope and ADR-0033's consequences; those records are
marked, not rewritten.

## Context
Two different things were being called "harness", "driver", "adapter",
"context engine" and "shakeout" interchangeably. The fixed loop of ADR-0012 is
one way to own an agent loop; the Claude Code CLI — its own history, its own
compaction, its own preamble — is another. The runner reached the second one
through a driver named `claude-subscription`, and because ADR-0004 says a
result needs a fixed, published harness, every run through it was stamped
`shakeout-only (external scaffold)` and kept off every chart. That stamp did
two jobs at once: it named *which loop* ran the episode and it said *this does
not count*. The first is a fact worth recording on every run; the second was a
judgement that has now been reversed. Meanwhile `harnessVersion` — the `git
describe` of this repository — sat next to a `contextEngine` string in the
comparability tuple and read as if it were the same kind of thing.

## Decision
**Harness** is what owns the agent loop and the context management. Two values:

- `wrathbench` — our fixed loop, ADR-0012's context policy.
- `claude-code` — the Claude Code CLI scaffold.

**Driver** is how the runner reaches the model: `openai` (any OpenAI-compatible
endpoint) or `stub` (scripted; harness tests; never scores). Under the
`claude-code` harness there is no separate driver — the CLI is the transport —
so the config value is `driver: "claude-code"` and the harness follows from it.

**The harness is recorded as a tag, not used as a partition.** The comparability
tuple's `contextEngine` field becomes `harness` (`wrathbench` | `claude-code`).
Every run, eval row, ladder row and models row shows it, and `?harness=` on
`/api/eval`, `/api/ladder` and `/api/models` narrows to one — but the default
is `all`, and the comparability group key does not include it. The operator
chose not to partition on the harness for now: claude-code rows sit in the same
charts and groups as wrathbench rows, visibly tagged. This may be revisited;
partitioning would be a reader change, never a rewrite of stored runs.

**The shakeout rule reduces to what was always true without it.** `stub` never
scores (it is not a model); a run with an operator objective never scores
(ADR-0033); `freeplay` never scores. Nothing about the claude-code harness
unscores a run. The `shakeout` key in meta.json and the `shakeout` column in
run.sqlite keep their names — old runs carry them — and now hold only the
unscored stamp (`unscored (scripted stub)`, `unscored (operator objective)`).
The pre-ADR-0035 stamp `shakeout-only (external scaffold)` is recognised by the
reader and dropped: such a run reads as a scorable `claude-code` row.

**Aliases on read, never on write.** `claude-subscription` (driver) and the
legacy `adapter` config field parse as `claude-code`; a stored tuple's
`contextEngine` (`harness-fixed-window` → `wrathbench`,
`external-scaffold-claude-cli` → `claude-code`) maps to `harness` in the reader.
Existing meta.json and roster files resume, old runs render, and no new file
writes the old words. A supervisor started before this record still only knows
the old spelling, so the live `infra/fleet.json` keeps `claude-subscription`
until the next fleet restart; the new code reads both.

**`harnessVersion` is unchanged and is a different word.** `harness` says which
loop; `harnessVersion` says which build of *this repository* — and it applies to
both harnesses, because the SDK, the MCP tools, the prompt and the sandbox that
Claude Code drives are ours. A `claude-code` run on `harness-0.3-70-gabc` and a
`wrathbench` run on the same version share the version and differ in the loop.

## What stays attributed to the claude-code harness
- The tool-call ceiling (`maxToolCallsPerEpisode`, `tool-call-limit`) exists
  because a claude-code turn is not a fixed-loop turn: one has held 168 tool
  calls, and the CLI has no `--max-turns`. It is a runaway guard enforced at
  the MCP boundary, not a scoring penalty.
- COSTS.md's context-growth account — the conversation replays every turn and
  grows unbounded — is a property of that harness, and the reason its
  cost shape differs. It explains a number; it does not unscore a row.
- Lane policy is unchanged: claude models run only through the claude-code
  harness, and that harness carries claude models only.

## Alternatives
- Keep the shakeout rule and add a second leaderboard for scaffolds (ADR-0004's
  "open scaffold leaderboard"): two boards for one set of runs, and the word
  "shakeout" still meaning two things.
- Partition by harness by default with a selector: considered and declined for
  now; the tag is enough to make the mixing visible, and a selector can be
  added without touching stored data.
- Rename the storage key `shakeout` too: would need a migration across every
  run directory for a cosmetic gain; the key is documented instead.

## Consequences
- `runner/src/config.ts`: `DRIVERS = openai | claude-code | stub`,
  `HARNESSES = wrathbench | claude-code`, `harnessOf(driver)`,
  `unscoredStamp`, `readUnscoredStamp`; `SHAKEOUT_DRIVERS`, `SHAKEOUT_STAMP`,
  `isShakeoutDriver` and `shakeoutStamp` are gone.
- `runner/src/comparability.ts`: `harness` replaces `contextEngine`;
  `parseComparability` maps old tuples; `harnessOfRun` derives a tag for a run
  that predates the tuple.
- `unscoredReason` no longer names a driver other than `stub`.
- Every pre-ADR-0035 claude run now enters the eval and ladder views it was
  excluded from. Anyone reading a chart across that date should expect the
  rows to have appeared, and can narrow with `?harness=wrathbench`.
