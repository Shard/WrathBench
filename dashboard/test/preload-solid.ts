/**
 * Point `solid-js` at the reactive build, for every dashboard test.
 *
 * `bun test` resolves the bare specifier under the node condition, which is
 * Solid's server build: its signals never notify. A graph test against it does
 * not test the graph, so the four files that exercise the page's derivations
 * need the browser build behind the name their sources import.
 *
 * This lives in a preload rather than in those files because the redirect is a
 * resolution concern and resolution happens once per process. A `mock.module`
 * inside a test file only wins if nothing has loaded `solid-js` yet, and the
 * dashboard has ordinary tests — the poller's verdict, the stale-build check —
 * whose subjects import Solid for their own reasons. One of those loading first
 * pins the server build for the whole run and the redirect silently loses; the
 * graph tests then fail somewhere far from the cause. Preload runs before any
 * test file, so the order stops mattering.
 *
 * Registered in `bunfig.toml` here and at the repository root, because bun
 * reads its config from the working directory and the suite is run from both.
 */

import { mock } from "bun:test";

const reactive = await import("solid-js/dist/solid.js");
mock.module("solid-js", () => reactive);

const webModule = "solid-js/web/dist/web.js";
const web = await import(webModule);
mock.module("solid-js/web", () => web);
