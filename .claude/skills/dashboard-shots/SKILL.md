---
name: dashboard-shots
description: Render the WrathBench dashboard locally, private viewer and public build side by side over fixture or copied runs, and screenshot it headlessly with `bun wb dashboard shots`. Use after any change under `dashboard/` or to the viewer's API or the publisher's output, to see it in a real browser (phone width and light mode included) before claiming it works; never start servers or a browser by hand for this.
---

# Dashboard shots

```
bun wb dashboard shots --out <dir>                         # both sites, every named state
bun wb dashboard shots --out <dir> --site public --viewport 390x844 --scheme light
bun wb dashboard shots --out <dir> --path /runs --path /models
bun wb dashboard shots --out <dir> --run <run-dir> [--run <run-dir>]
bun wb dashboard shots --serve                             # the stack only: URLs until Ctrl-C
```

About 20–30 s. Put `--out` in your scratchpad, then look at the PNGs with
Read. It writes `private-<state>.png` and `public-<state>.png` for each named
state, one `path-*.png` per `--path`, and `facts.json` with each page's
uncaught errors, console errors and third-party requests. It exits 1 when a
page threw or a state was not reached.

| State | What it shows |
| --- | --- |
| `home` | the landing page |
| `run-live` | the live run's page |
| `map-live` | nothing selected: the sidebar lists the live characters |
| `map-live-selected` | the live character's row clicked: the map framed on it, with its money, bags and quests |
| `map-live-nearby` | then zoomed in on it: the units around it |
| `map-replay` | the ended run, paused halfway |

The rig is self-contained (`infra/dashboard-shots.ts`; `dashboard/README.md`,
"Screenshots", says what it stands up): invented fixture runs, or copies of
each `--run` directory, and nothing read from the operator's ClickHouse,
config store or `data/runs`, so it is safe while runs are live. Wowhead's
tooltip script is stubbed and every other third party refused, so names read
as they do where the script is blocked; `--real-wowhead` lets it through.
Chromium comes from the PATH or `WRATHBENCH_CHROMIUM`, with no dependency to
install; `--settle MS` sets the wait before each shot (2500 by default).

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

Copy a run that has ended (skill `fleet-readonly`; never a live one) out of
the runner pod, leaving its live files behind, then pass the directory with
`--run`:

```
kubectl -n <ns> exec deploy/<release>-runner -- tar -C data/runs -cf - --exclude=nearby --exclude=heartbeat <run-id> | tar -C <dir> -xf -
```

The copy holds `meta.json`, and so the run's session token, and its shots
show real character names: keep both in your scratchpad, and never print,
commit or publish them.
