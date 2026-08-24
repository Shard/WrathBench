# Dashboard

The operator SPA over the viewer's read-only API: fleet overview, one page per
run, and the live map. SolidJS + Vite, TypeScript strict, no CSS framework.

Why an SPA and why a dependency at all: ADR-0022.

## Running

Two ways, and they must behave the same.

**Development** — Vite serves the SPA and proxies `/api` and `/tiles` to a
viewer you run yourself:

```
bun runner/viewer/serve.ts          # terminal 1: the API, on 127.0.0.1:8090
bun run dashboard:dev               # terminal 2: http://127.0.0.1:5180
```

`WRATHBENCH_VIEWER_ORIGIN` points the proxy somewhere other than 8090 — useful
when the operator's own viewer already owns that port.

**Production** — build once, and the viewer hosts the result itself:

```
bun run dashboard:build             # writes dashboard/dist
bun runner/viewer/serve.ts          # http://127.0.0.1:8090
```

The viewer serves `dashboard/dist` when it exists. When it does not there is no
UI at all — page routes answer with a plain-text notice naming the build command
— so a checkout that wants the dashboard has to build it.
`WRATHBENCH_DASHBOARD_DIR` overrides where the viewer looks.

## Routes

| route | what |
| --- | --- |
| `/` | fleet overview: the supervisor, the gate, one table of jobs and accounts, paused and ended runs |
| `/episodes` | the tiers: what each id fixes, and how many runs sit against it; a tier's member count leads to its ladder |
| `/runs` | every run, as a sortable table — the per-run grain (ADR-0047); `/results` redirects here |
| `/ladder` | one tier at a time: a scatter of average cost per run against average XP earned, one point per model, over the rungs each model has reached (ADR-0018) |
| `/models` | the roster with the scheduler's verdict on each entry |
| `/campaigns` | probe campaign coverage: cells swept, by how many models (ADR-0041) |
| `/run/:id` | one run, turn by turn, following the file live |
| `/map` | every live agent on the world map |

One page per grain (ADR-0022 amendment, ADR-0047): the fleet page is what is
running *now* and links to a run, never listing them; `/runs` is the runs;
`/episodes` is the tiers; `/ladder` is aggregates over runs. A tier's member
count on `/episodes` leads to that tier's ladder, and a point on the ladder's
chart leads to the runs behind it.

## The series selector

The harness series (`major.minor`) is the comparability group, so every page
that shows runs is a view of one. There is one selector for all of them, in the
top bar (ADR-0046) — `all`, `latest`, then each series with runs, descending —
and it filters `/runs`, `/ladder` and the live agents on `/map`; `/episodes`
lists no runs, so it has nothing to filter. `latest` is stored as the token, so it
follows a minor bump. The choice
rides in `?series=` and in `localStorage`; the URL wins, so a shared link means
what its sender saw.

It is not the `?harness=` filter of ADR-0035, which selects which *loop* owned a
run (`wrathbench` or `claude-code`). Different dimension, same word. `/runs`
still filters on it by clicking a cell; the ladder no longer offers it as a
control (the harness is a tag on each row and a colour on each point, not a
partition), and offers neither `all` nor overridden runs as an episode choice —
a rung and a scatter are claims about one comparability group.

`/` and `/models` are not filtered: the fleet is what is running now, and the
models page is the scheduler's verdict computed against the current series
server-side. `lib/harness.ts` holds the pure half and its tests.

## Structure

```
src/api/      typed client over the viewer JSON endpoints, and the SSE tail
src/lib/      pure helpers: view maths, formatting, polling
src/pages/    one file per route
src/components/  the shell and the pieces shared between pages
```

Two modules are imported from the viewer rather than copied, under the
`@viewer/*` alias:

- `runner/viewer/api-types.ts` — the wire shapes. The viewer imports the same
  file, so a drift between what it serves and what this expects is a compile
  error rather than a runtime surprise.
- `runner/viewer/worldmap.ts` — the world→tile transform (ADR-0019). Both are
  import-free by construction, so nothing server-side follows them into the
  browser bundle.

## Tests

`bun test` from the repo root runs them with everything else. They cover the
pure layer — view maths and pip placement, the API client's paths, encoding and
error mapping — and not the components: a DOM harness for a handful of `<For>`
loops would cost more than it pins.

## Conventions

- Nothing here writes. There is no client method that sends a body, because
  there is no route that takes one.
- Paths are root-relative, so the same code runs behind the dev proxy and
  same-origin off the viewer. That is why there is no CORS configuration.
- Polling intervals are stated at each call site, not hidden in `poll()` —
  ADR-0022 names polling rate as a public-hosting constraint.
