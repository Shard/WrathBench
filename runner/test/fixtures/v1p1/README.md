# A frozen phase-1 v1 run

`v1p1-solo` is one run as the first v1 runner left it: the stack's session
record in `session/` (trace, events; no tool calls were made), and beside it
the two things the loop still wrote from the same state cache, run.sqlite's
60-second `state` rows (in `run.sql`, the `run` and `state` tables as text) and
the trajectory's `milestone` and `quest_complete` records. Later v1 runs have
only the record, so this overlap is the one place the scorer's move from the
state table onto the trace can be checked against what the old readers derived
(`runner/test/record-equivalence.test.ts`).

It was made once, by `generate.ts` at WrathBench e9f6f26c (wrath-mcp
149fb163), driving that commit's own `ContextBuilder`, `Trajectory`, recorders
and `SessionWriter` on a fake clock. **Never regenerate it**: the writers that
made the `state` rows and milestones are gone, and a fixture rebuilt by later
code would prove nothing about the overlap. `generate.ts` stays only as the
record of how it was made, and no longer runs.

Twenty minutes of invented play: a login at level 5, a kill every twenty
seconds, loot, a new item, an equip, turn-ins at 200, 480 and 720 seconds,
level-ups at 330 and 900, an area change and a zone change, a learned spell,
an earned achievement, and a sandbox restart at 660 seconds (a new cache and
new recorders; the character logs in again).
