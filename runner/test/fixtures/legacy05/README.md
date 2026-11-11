# Frozen 0.5 runs

Three run directories as the WrathBench 0.5 runner left them on disk, and the
viewer's answers over them (`golden/`). `runner/test/legacy05-golden.test.ts`
lays them out as a runs directory, reads them through the viewer API at a fixed
instant and compares every answer with its golden. The point is that a run
recorded before the session recording moved out of the runner stays readable,
and reads the same, for as long as it exists.

These are frozen artifacts. They were generated once, at WrathBench f61e391d,
by driving that commit's own writers (`Trajectory`, `TraceWriter`,
`NearbyWriter`, `EpisodicLog`) on a fake clock, and dumping each `run.sqlite`
to text. **Never regenerate them from newer code**: a fixture rebuilt by a
later writer is a fixture of that writer, and the test would then prove
nothing about 0.5 runs. If a reader needs a 0.5 shape these runs lack, add it
by hand in the 0.5 shape, and say so here.

Every name and id in them is invented: characters, creatures, items, quests,
zones and maps are made-up strings and arbitrary numbers. The turn records
carry a short stand-in system prompt rather than the 0.5 one, and the model,
provider and session tokens are fictional.

## Layout

Each run directory holds `meta.json`, `trajectory.jsonl` and `scratchpad.md` as
they were on disk, plus `run.sql`: the 0.5 schema as the writer created it
(its comments left out) and every row in rowid order. The test replays it
into `run.sqlite` with `bun:sqlite` and imports nothing from `runner/src` to
do so. File times are set from the content: each file of a run at its
trajectory's last record, each ring file at its own last row.

## The runs

- `l05-party-a1`: a finished probe run, the tank of a three-member party.
  Three trace windows of `key`, `pos` (with `jump`), `state` and `flight`
  rows; sheet patches to money and to every list but `bags`, `qdone`, chat lines of five kinds, and a
  `trace_dict` with item and quest entries. `move` dispatches and verdicts;
  `state` rows with and without `items`. Milestones of every kind the 0.5
  writer had (zone, area, level, achievements, spells, talent, trade, death,
  release, resurrect, taxi, taxi_landed, group, instance, kill), `actions`
  with a refusal, `events_served` with `WB_AREA` names, snippets, a failed
  snippet, tool calls and results, `quest_complete`, `episodic`, and a
  `client-cache.json` naming the boss.
- `l05-freeplay-1`: a freeplay character's first attempt, recorded before the
  recorder: no `trace` or `trace_dict` table at all, an empty `move` table,
  no `items` on any state row, one response without usage.
- `l05-freeplay-2`: the same character's second attempt (`continuedFrom`),
  live at the test's instant: one closed trace window and a tail of two, an
  in-flight move, an open reflection window, an `episodic.jsonl`, and a
  `nearby/` ring of two one-minute files holding a player, its pet, creatures
  that move, change, are named late, enter and leave, and the character's own
  target.

## The goldens

`golden/<private|public>/<path>.json` holds the status, the content type, the
cache header and the body one request answered. Regenerating them is for a
deliberate API change only; the header of the test file says how and when.
