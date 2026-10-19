---
name: dashboard-shots
description: Render the WrathBench dashboard locally, private viewer and public build side by side, over fixture or copied runs, and take headless screenshots at named states with `bun wb dashboard shots`. Use to check a dashboard or viewer change in a real browser, at phone width or in light mode, before claiming it works; never rebuild a render rig by hand.
---

# Dashboard shots

```
bun wb dashboard shots --out <dir>                         # both sites, every named state
bun wb dashboard shots --out <dir> --site public --viewport 390x844 --scheme light
bun wb dashboard shots --out <dir> --path /runs --path /models
bun wb dashboard shots --out <dir> --run <run-dir> [--run <run-dir>]
bun wb dashboard shots --serve                             # the stack only: URLs until Ctrl-C
```

About 20–30 s. Put `--out` in your scratchpad. It writes
`private-<state>.png` and `public-<state>.png` for `home`, `run-live`,
`map-live` (nothing selected: the sidebar lists the three live characters),
`map-live-selected` (the live character's row clicked: the map framed on it,
its money, bags and quests), `map-live-nearby` (then zoomed in on it: the
units around it) and
`map-replay` (paused halfway), one `path-*.png` per `--path`, and
`facts.json` with each page's uncaught errors, console errors and third-party
requests. It exits 1 when a page threw or a state was not reached. Look at the
PNGs with Read.

What it stands up (`infra/dashboard-shots.ts`; `dashboard/README.md`,
"Screenshots"): invented fixture runs written by the runner's own
`Trajectory`, one kept live while the rig runs and one ended, or copies of each
`--run` directory; the viewer's `createApi` with a private build; one publisher
pass into a local bucket and a public build reading it; headless Chromium over
the DevTools protocol, with no dependency to install. Wowhead's tooltip script
is stubbed and every other third party refused, so names read as they do where
the script is blocked; `--real-wowhead` lets it through. Nothing reads the
operator's ClickHouse, config store or `data/runs`. Chromium comes from the
PATH or `WRATHBENCH_CHROMIUM`.

## States that need clicks

Script it against the rig rather than starting servers yourself:

```ts
import { startRig } from "<repo>/infra/dashboard-shots.ts";
const rig = await startRig({ out: "<dir>" });
const p = await rig.page("public", { width: 1440, height: 900 });
await p.open(`/map?run=${rig.ended}`, "input.scrubber");
await p.seek(0.8);
await p.page.click(".popover-anchor.bag .popover-button");
await p.shot("public-replay-bag");
await rig.close();
```

`rig.page()` pages also have `select(character)`, `page.eval(js)`,
`page.clickAt`, `page.wheel` and `page.facts`; `rig.publish()` runs another
publisher pass.

## A real run

Copy an ended run out read-only, leaving its live files behind, then pass the
directory with `--run`:

```
kubectl -n <ns> exec deploy/<release>-runner -- tar -C data/runs -cf - --exclude=nearby --exclude=heartbeat <run-id> | tar -C <dir> -xf -
```

Shots of a real run show real character names: keep them in your scratchpad,
and never commit or publish them.
