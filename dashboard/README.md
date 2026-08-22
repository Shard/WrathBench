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

The viewer serves `dashboard/dist` when it exists and falls back to the
hand-written pages when it does not, so a fresh checkout needs no build step.
`WRATHBENCH_DASHBOARD_DIR` overrides where it looks.

## Routes

| route | what |
| --- | --- |
| `/` | fleet overview: lanes, accounts, heartbeat, and every run |
| `/run/:id` | one run, turn by turn, following the file live |
| `/map` | every live agent on the world map |
| `/legacy/…` | the hand-written pages this replaces, until they are deleted |

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
