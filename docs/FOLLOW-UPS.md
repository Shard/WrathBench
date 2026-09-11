# Follow-ups

Open items only, grouped by area. Numbers are stable — ADRs, commits and the worklog
cite them — so gaps are normal and nothing is renumbered.

When an item ships or is rejected it leaves this file entirely: the day file in
`docs/worklogs/` records it with the commit, and that is where a citation to its
number resolves — `grep -rn "item 64" docs/worklogs/`. An item with no next action
and no trigger leaves the same way, to a GitHub issue.

**This file is a list of work someone could pick up, not a record of everything
known.** It carried a resolved ledger until 2026-08-24; at 64 entries the archive
was larger than the list, which is the failure mode to avoid rather than repeat.

Each open item says what, why it matters (with evidence), what unblocks it, and
status.

## Player surface

The 2026-08-29 fan-out audit (three subagents — the SDK surface, the module's
taps, and every trajectory to date) found a character who can walk, fight, quest,
train, fly and bind, and who cannot see or spend most of what a level-10 player
handles. Observed need is thin on purpose here: across 11 Claude runs no snippet
ever called `sdk.raw()` and the highest level reached was 9, so nothing below is
"a trajectory asked for it" — it is the surface a player needs before a run can
get far enough to ask. **Operator's decision, 2026-08-29: complete the basic
player surface, each piece validated by a smoke test, before any 0.6 talk.**
Items 95–101 all shipped the same day (97f4e31, dc8c9aa, 3dfd712, 5981a29;
worklogs/2026-08-29).

## Deployment

120. **Watch `iscsi-nvme` under a live fleet** (2026-09-08, out of the cutover).
    The data volume is `iscsi-nvme` because every run's evidence is a SQLite
    file and that class gives an honest fsync (`docs/DEPLOY-NUSPHERE.md`,
    "Decisions behind the shape"). Nothing before the cutover exercised it with
    the supervisor writing `run.sqlite` for two concurrent episodes over iSCSI;
    the staged bring-up only read. If it disappoints, the data volume moves to
    `local-path` — the node is pinned to `chungusjr` anyway, so the only thing
    given up is the honest fsync, which is the whole reason it is not there
    already. Trigger: the fleet's episode logs show module timeouts or
    `run.sqlite` write stalls.

## Docs and release

124. **The other two cold memos `/api/models` fills** (2026-09-11, measured
    while shipping item 115). With the fact cache persisted, the first
    `/api/models` on a fresh process against the operator's 346-run tree is
    22.9s / 20.4s, down from 33.7s / 35.2s. What is left is the same route's
    two other cold caches, both keyed on the identical `(size, mtime)`
    signature and both therefore persistable the same way: `totalsCache` in
    `runner/viewer/api.ts` (a `RunTotalsScanner` per run, from byte zero) and
    `runReadCache` in `runner/viewer/runs.ts` (one sqlite open per run). Sizes
    are known and small — trajectory totals measured ~0.8 KiB of JSON a run,
    ~0.3 MiB for the tree — so the store in `runner/viewer/fact-store.ts` takes
    a second collection rather than a rewrite. Not done with item 115 because
    the two are heavier objects than a `RunFact` and the state series behind a
    run row is unbounded, which wants its own decision about what is worth
    writing down. Trigger: the same one item 115 had — restarts frequent enough
    to notice, or a corpus that makes 22s into minutes.

118. **The codex driver's next steps** (2026-09-05; shipped in 3d8666e,
    7eb44c8, d2b46a1, 3e4a130, b27fd02 — see the day file). Three things left,
    in the order they bite:
    (b) **Per-lane fleet accounting** — a codex run counts only against the
    `codex` key. A lane NAME is in `policy.subscriptions` and pins an entry
    (CODEX_HOME does, since b27fd02), but there are no `codex:<ENV NAME>`
    concurrency keys, so a second ChatGPT subscription gets no cap of its own
    and the two would share the single `codex` slot. (c) **`codex app-server` as the
    transport** once it is no longer marked experimental: a long-lived process
    (no per-turn startup + MCP handshake), `thread/tokenUsage/updated` and
    `account/rateLimits/updated` (exec mode never reports the usage window,
    codex issue #14728), and the typed misalignment steer for a
    `provider-policy` stop — which stays the operator's decision, never
    automatic. (d) **Astra facts to keep with the lane**: model id
    `gpt-6-astra`, released 2026-09-03, needs codex >= 0.153.0 (0.153.4 makes
    it the default); the ChatGPT catalogue reports a 272k context (the API's
    1.05M/922k is not what this lane sees) and efforts
    low|medium|high|xhigh|max|ultra; the subscription is ChatGPT Pro ("proX5"),
    5-hour windows plus weekly caps, shared with the operator's own Codex use,
    no per-turn cost. Next action: (b) when a second ChatGPT subscription
    exists; (c) when `codex app-server` leaves "experimental".
