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

## Next up

1. **38** — N1, N2 and N3 all shipped and deployed; what is left is N4, the
   rung-4 attempts, plus the "unaided" half of the N3 gate (a model discovers
   and uses a flight master on its own).

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

## Navigation

38. **Navigation plan — rungs 2–4** (2026-08-22; supersedes item 18). Rung 4 — a
    capital, the tram, one flight, unaided — is the public release trigger
    (VISION.md). Scoped to walking, the Deeprun Tram and flight masters; boats,
    zeppelins and elevators are rung-7 work. Source: the 2026-08-22 spatial-delivery
    synthesis and the travel probe (worklogs/2026-08-22).
    - **N1 — actions and statuses: shipped and deployed** (commits
      92f7df1..b88dd1d, live as `harness-0.3-68` since 2026-08-23). Typed `no_path`
      causes with the subdivision retry in the module, `CMSG_AREATRIGGER` on entering
      a DBC volume, transfer packets tapped and `waitForTransfer` typed,
      transport-relative movement. **Gate passed 2026-08-23** on `harness-0.4-73-gafd352c`:
      `travel.ts --from tram-ironforge --rides 3` (item 45 fixture) rode IF→SW three
      times with typed success on every leg, boarding on attempt 1 each time, rides
      60s; N1 is proven. One residual left: triggers are only tested while a
      `move_to` is active.
    - **N2 — field-level observations**, each small, each earned, each logged.
      **Shipped 2026-08-23 (an N1 amendment, built to `:next`, awaiting the deploy
      window):** zone and area name on self (`WB_AREA` from the server's zone/area pair
      named by the client's `AreaTable.dbc`; `state.self.zone` / `state.self.area`; HUD
      `position: Elwynn Forest / Northshire Valley — map 0 (x, y, z)`; `milestone`
      records `kind: zone|area` with ids only, plus `zone`/`area` state columns) and NPC
      roles on nearby units from `UNIT_NPC_FLAGS` (`UnitView.roles`, `units({ role })`,
      HUD `Gryth Thurden (flight master, 4.2y)` — role, not recommendation). Gate:
      `infra/smoke/area-and-roles.ts` (login names, one `WB_AREA` each way across the
      abbey door, Deputy Willem reports `questGiver`) — runs on the first deploy of the
      N2 build; if the server's ids disagree with the ones read from the map files, the
      smoke is corrected to the server's answer. **Innkeeper bind shipped 2026-08-29,
      deployed as `harness-0.5-225-ga2c0bd2`, gate passed the same day
      (`innkeeper-bind.ts`: login bind Coldridge Valley 132 → bind at Firebrew
      lands 0.0y from the character as Ironforge 1537):** `SMSG_BINDER_CONFIRM` / `SMSG_BINDPOINTUPDATE` /
      `SMSG_PLAYERBOUND` tapped, `CMSG_BINDER_ACTIVATE` on the raw allowlist,
      `state.self.bindPoint` (map, xyz, area id + AreaTable name), `bindAtInnkeeper`
      typed, HUD `home: Ironforge — map 0 (x, y, z)`. Payloads in
      worklogs/2026-08-29. Gate: `infra/smoke/innkeeper-bind.ts` (scenario
      `inn-ironforge`). N2 is complete.
    - **N3 — flight paths, shipped 2026-08-29, deployed as
      `harness-0.5-225-ga2c0bd2`, probe gate passed the same day:**
      `SMSG_SHOWTAXINODES` tapped exactly as the wire has it (show flag, guid,
      current node, 14-word mask) plus the mask decoded to `known[]` named from the
      client's `TaxiNodes.dbc`; `state.lastTaxiNodes(guid)`, `showTaxiNodes(guid)`
      (hello → the icon-2 taxi option → window), `activateTaxi(guid, nameOrId)`
      typed over raw `CMSG_ACTIVATETAXI` with a hint per `ActivateTaxiReply` code.
      Never the TaxiPath catalogue, never node positions, never a nearest-master
      lookup. `infra/smoke/taxi-nodes.ts` passed (window current 6 Ironforge,
      known 6/8/100 — 100 Honor Hold is the core's Alliance starting mask, not the
      fixture's; `activateTaxi(gryth, "Thelsamar")` accepted, fare 105c;
      `taxiFlight` true → false at 97s; landing zone Loch Modan). **Remaining:**
      the "unaided" half of the gate — a model discovers and uses a flight master
      on its own (N4 evidence). Residual seen on the gate: `state.self.position`
      still read the takeoff point after landing (the fold does not follow the
      flight spline; the zone did move) — a model reads its landing spot from
      `self.zone` until its first own step. Open question for the operator:
      whether the `TaxiNodes.dbc` node positions (which the client draws on its
      taxi map) are a contract-clean observation; withheld until decided.
    - **N4 — rung-4 attempts**: Opus/Fable runs with milestone records on, destination
      choice scored from the records (destination chosen → connector chosen → action
      dispatched → transfer confirmed / not_visited / waiting / wrong_map / stuck →
      arrival at server-confirmed map+xyz). Never "ended near the coordinate"; that
      scores `move_to`.
    - **Not in 0.3, by decision:** a `here()` / `goTo(name)` helper, a rendered minimap
      as model observation (the map stays operator-only), the TaxiPath /
      areatrigger_teleport tables, walkability masks, a persistent map notebook (a
      labelled context-engine change under 8b if ever). Wiki coordinates are a run
      dimension withheld from scored runs (docs/METHODOLOGY.md, "Episodes, lanes,
      and evidence"); pull back to a labelled coords
      tier only if the names-only ladder proves unclimbable.

## Episodes and results

## Deployment

116. **The NuSphere cutover has not been performed** (2026-09-05). The chart
    (`infra/chart/wrathbench`), the ConfigMap kustomization (`infra/k8s`), the
    image build (`infra/build-images.sh`), the deploy window
    (`infra/k8s-deploy.sh`) and the runbook (`docs/DEPLOY-NUSPHERE.md`) all
    exist and are lint/render/kubeconform clean, but **nothing has run**: no PVC
    has been bound, no pod has started, and the fleet is still on compose. The
    runbook is a plan, not a report. Unblocked by the nusphere-side PR
    (Shard/nusphere#149) merging; the cutover itself is a watched window, not a
    background task, because step 1 pauses live runs. Two things to confirm
    first with real workloads rather than argument: that `mysql:8.4` starts with
    `runAsUser: 1000` on the `iscsi-nvme` datadir (the documented fallback is
    999, db only), and that Flux's kustomize-controller builds `infra/k8s` with
    `LoadRestrictionsNone` — without it the ConfigMap silently stops generating
    and fleet steering stops with it, which is the one wrong guess here that
    breaks operation rather than a deploy.

117. **CI for the release contract** (2026-09-05; GitHub issue 7's addendum).
    None of it is built: PR checks on the pinned Bun with a frozen install, the
    full suite, typecheck, generated-API drift and the dashboard build; a tag
    workflow that produces a traceable image digest tied to one source SHA;
    chart lint/render in CI; and a check that refuses a mutable image reference.
    The chart's own guard — `image.tag` empty or `latest` refuses to render — is
    the only piece enforced today, and it fires at render time rather than at
    review time. Trigger: the first deploy that is not driven by hand.

## Docs and release

85. **Retire the gate Worker before launch** (2026-08-25; operator's explicit
    direction). The public dashboard currently runs the **Gated** shape —
    `dashboard/worker/index.ts` serving both the SPA and `/v1/*` from a private
    R2 binding behind a shared password — because the account has no zone and,
    on Cloudflare, access control and cache are custom-domain features. That is
    scaffolding for a private preview and **not what launches**. The launch
    shape is the design doc's **Open** one: R2 behind a custom domain with cache
    rules, an assets-only Worker with no `main`, and therefore no Worker
    invocation anywhere in the read path — so a traffic spike is absorbed by the
    edge cache at ~$0 and never reaches the lab or a per-request compute bill.
    No domain yet (operator, 2026-09-01): this is one of the last steps before the
    public launch, after the preview has been shared.
    Unblocked by a zone on the account (a nameserver move for an existing domain
    or a new registration; `shard.page` was considered and declined 2026-08-25
    because it points elsewhere). Then: attach the data custom domain, add the
    two cache rules, apply `infra/cloudflare/r2-cors.json` with the real origin,
    rebuild with `VITE_WRATHBENCH_SNAPSHOT_BASE=https://data.<zone>`, drop
    `main` and the `r2_buckets` binding from `dashboard/wrangler.jsonc`, delete
    `dashboard/worker/`, and remove `dashboard/worker` from the root typecheck
    loop. One more step since 2026-08-30: the map page requests `/tiles/...`
    same-origin, which only resolves while one Worker serves both the SPA and
    the bucket. In the Open shape those requests need the data hostname (the
    tiles are published under `tiles/` in the same bucket, so a
    `VITE_WRATHBENCH_SNAPSHOT_BASE`-relative tile URL plus a cache rule and a
    CORS entry for the prefix), and whatever replaces the gate has to keep them
    behind it. Gated by issue #10 (entries/game-text) in the same breath, since
    removing the gate is what makes the deploy genuinely public.

109. **Hide the GitHub link until the repo opens** (2026-09-01). The footer and the
    BibTeX entry link to `github.com/Shard/WrathBench`, which 404s while the repo is
    private (`dashboard/src/components/Layout.tsx`, `pages/About.tsx`). The preview is
    shared first and the repo opens after; hide or open on the day it flips. The rest
    of the pre-open checklist was decided 2026-09-01: the operator's first name stays
    in the worklogs, `docs:api` drift was fixed in place, the copy rewrites are done.
111. **Social previews: let the crawler through** (operator, 2026-09-01). The
    tags and the ship-time Pareto card shipped the same day (`dashboard/src/lib/og.ts`,
    `infra/render-og.ts`, `docs/PUBLIC-DASHBOARD.md` "The social card") and the
    public build carries `og:image` → `/og.png`. Nothing unfurls yet: the gate
    Worker answers every credential-less request — Discord's crawler included —
    with the 401 password form, and serves a `robots.txt` that disallows
    everything ahead of the gate (Slack and Twitter honour it; Discord does not).
    Two ways out, the operator's call: exempt `/`, `/og.png` and a permissive
    `robots.txt` for crawler user agents in `dashboard/worker/index.ts` (a
    spoofable UA gets the landing page's HTML — marketing copy, not run data —
    and the card), or wait for item 85, where the Open shape has no gate and the
    problem disappears. Verify with Discord's unfurl after either.

114. **`sdk.connect()` drops a client without closing its stream** (2026-09-04,
    found while fixing item 113). `connect()` in `sdk/src/client.ts:2184` does
    `if (options.subscribeEvents ?? true) await client.events.connect();` and
    returns. If that rejects, the `WrathClient` is discarded — but its
    `EventStream` is not closed, and with reconnect enabled the ladder keeps
    retrying forever with nobody holding a reference able to `close()` it. One
    leaked socket ladder per failed `connect()`, for the life of the process.
    Pre-existing, but item 113 makes it more reachable: `events.connect()` now
    rejects on a whole failed climb of the ladder, which is a new rejection path
    where before an unreachable server simply hung. The fix is small — close the
    stream before rethrowing — but it belongs with a look at whether
    `WrathClient` should own that cleanup generally, since the same shape will
    recur for anything else the constructor starts. Trigger: any run whose
    process shows repeated reconnect logs for a client nothing holds.

115. **The viewer re-counts the whole corpus on every process start** (2026-09-04,
    disclosed by the agent that fixed the live-run half in fe3dec4). The first
    `/api/models` after a viewer restart takes ~18.5s: the process fills its fact
    cache across all 329 trajectories — 4.4 GB, ~9.3s of counting plus ~330
    sqlite opens. **Not a regression**: the old whole-file `readFileSync` path
    cost 10.4s for the same fill, and the steady state it replaced was 1–4s
    spikes every 5s forever, which is strictly worse. But it is now the largest
    single cost left in the viewer, and it is paid again on every restart —
    which `bun ship --publisher` and every deploy trigger.
    The fix is a persisted cache: the per-run counts are a pure function of
    `(size, mtime)` and a finished run's never change, so ~327 of the 329 could
    be read from disk rather than recomputed. Wants a cache file the viewer
    writes on shutdown or incrementally, invalidated by the same signature the
    in-memory cache already uses. Trigger: viewer restarts becoming frequent
    enough to notice, or the corpus growing enough that 18.5s becomes minutes —
    it scales with total trajectory bytes, which only ever grows.
