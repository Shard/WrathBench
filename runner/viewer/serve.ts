#!/usr/bin/env bun
/**
 * Operator-facing viewer for run trajectories, live and past.
 *
 *   bun runner/viewer/serve.ts            # from the repo root, on the host
 *
 * Loopback only, always. Trajectory content carries game-derived text and per
 * `docs/DATA-AND-LEGAL.md` none of it may be exposed beyond this machine, so a
 * configured bind address other than 127.0.0.1 is a startup failure rather than
 * something the operator can talk the process out of.
 *
 * Everything here reads. The runs directory is never written to, and each
 * run.sqlite is opened readonly so a live writer is untouched.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PAGE } from "./page";
import { listRuns, readRun, readScratchpad, readStates, runDir } from "./runs";
import { TrajectoryTail, tokenTotals, type EntrySummary } from "./tail";

const REQUIRED_HOST = "127.0.0.1";
const host = process.env["WRATHBENCH_VIEWER_HOST"] ?? REQUIRED_HOST;
if (host !== REQUIRED_HOST) {
  console.error(
    `refusing to start: WRATHBENCH_VIEWER_HOST=${host}. The viewer serves game-derived ` +
      `trajectory text and binds ${REQUIRED_HOST} only (docs/DATA-AND-LEGAL.md).`,
  );
  process.exit(1);
}

const port = Number(process.env["WRATHBENCH_VIEWER_PORT"] ?? 8090);
const runsDir = process.env["WRATHBENCH_RUNS_DIR"] ?? "data/runs";
if (!existsSync(runsDir)) {
  console.error(`no runs directory at ${runsDir} — run from the repo root, or set WRATHBENCH_RUNS_DIR.`);
  process.exit(1);
}

const POLL_MS = 1000;
const WINDOW_MAX = 500;

/** One tail per run, shared by every reader; scans are serialised per run. */
const tails = new Map<string, TrajectoryTail>();
const scans = new Map<string, Promise<EntrySummary[]>>();

function tailFor(runId: string, dir: string): TrajectoryTail {
  let t = tails.get(runId);
  if (t === undefined) {
    t = new TrajectoryTail(join(dir, "trajectory.jsonl"));
    tails.set(runId, t);
  }
  return t;
}

/** Serialise scans: two concurrent readers must not both consume the same bytes. */
function scan(runId: string, tail: TrajectoryTail): Promise<EntrySummary[]> {
  const prev = scans.get(runId) ?? Promise.resolve([] as EntrySummary[]);
  const next = prev.then(
    () => tail.scan(),
    () => tail.scan(),
  );
  scans.set(runId, next);
  return next;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(): Response {
  return new Response(PAGE, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function notFound(msg: string): Response {
  return json({ error: msg }, 404);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = decodeURIComponent(url.pathname);

  if (path === "/" || path.startsWith("/run/")) return html();
  if (path === "/api/runs") return json({ runs: listRuns(runsDir) });

  const m = /^\/api\/run\/([^/]+)(\/.*)?$/.exec(path);
  if (m === null) return notFound("no such path");
  const runId = m[1]!;
  const rest = m[2] ?? "";
  const dir = runDir(runsDir, runId);
  if (dir === null) return notFound(`no such run: ${runId}`);
  const tail = tailFor(runId, dir);

  if (rest === "" || rest === "/") {
    await scan(runId, tail);
    return json({
      run: readRun(runsDir, runId),
      states: readStates(runsDir, runId),
      total: tail.entries.length,
      tokens: tokenTotals(tail.entries),
    });
  }

  if (rest === "/entries") {
    await scan(runId, tail);
    const total = tail.entries.length;
    const limit = Math.min(WINDOW_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
    const fromParam = url.searchParams.get("from");
    const from = fromParam === null ? Math.max(0, total - limit) : Math.max(0, Number(fromParam));
    return json({ from, total, entries: tail.entries.slice(from, from + limit) });
  }

  const rawMatch = /^\/raw\/(\d+)$/.exec(rest);
  if (rawMatch !== null) {
    await scan(runId, tail);
    const raw = await tail.raw(Number(rawMatch[1]));
    if (raw === null) return notFound("no such entry");
    return new Response(raw, {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (rest === "/scratchpad") {
    const text = readScratchpad(runsDir, runId);
    if (text === null) return notFound("no scratchpad");
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (rest === "/stream") {
    await scan(runId, tail);
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown): void => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        };
        send({ hello: runId, total: tail.entries.length });
        timer = setInterval(() => {
          void scan(runId, tail)
            .then((added) => {
              // A heartbeat keeps proxies and fetch timeouts from calling it dead.
              send(
                added.length > 0
                  ? { entries: added, tokens: tokenTotals(tail.entries) }
                  : { tick: Date.now() },
              );
            })
            .catch(() => undefined);
        }, POLL_MS);
      },
      cancel() {
        if (timer !== undefined) clearInterval(timer);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }

  return notFound("no such path");
}

const server = Bun.serve({
  hostname: REQUIRED_HOST,
  port,
  idleTimeout: 0,
  fetch: (req) =>
    handle(req).catch((err: unknown) =>
      json({ error: err instanceof Error ? err.message : String(err) }, 500),
    ),
});

console.log(`wrathbench viewer: http://${REQUIRED_HOST}:${server.port}  (runs: ${runsDir})`);
