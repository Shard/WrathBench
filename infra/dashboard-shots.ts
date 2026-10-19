#!/usr/bin/env bun
/**
 * `bun wb dashboard shots`: the dashboard rendered here, private and public,
 * over runs nobody else can see, and screenshots of it at named states.
 *
 *   bun infra/dashboard-shots.ts [--out DIR] [--run DIR]… [--path P]… [--site private|public|both]
 *                                [--viewport WxH] [--scheme dark|light] [--settle MS] [--real-wowhead]
 *   bun infra/dashboard-shots.ts --serve [...]     the same stack, no browser: print the URLs and wait
 *
 * What it stands up, all on loopback and ephemeral ports, all under DIR/.rig:
 *
 *  - the runs: the synthetic fixture (`infra/shots/fixture.ts`: one live run
 *    kept live while the rig runs, one ended run to replay), or copies of the
 *    run directories `--run` names, which are never served or written in place;
 *  - the private viewer: the viewer's own `createApi` over those runs, with an
 *    in-memory run store and a config store of its own, hosting a private build;
 *  - the public site: one publisher pass by the publisher's own renderer and
 *    engine into a directory served with CORS as the bucket, and a public build
 *    pointed at it (`VITE_WRATHBENCH_SNAPSHOT_BASE`);
 *  - a headless Chromium over the DevTools protocol (`infra/shots/cdp.ts`),
 *    with Wowhead's tooltip script stubbed and every other third party refused,
 *    unless `--real-wowhead`.
 *
 * Nothing reaches the operator's stores: no ClickHouse, no config store, no
 * `data/runs`. The local minimap tiles are served when `data/minimap` has them,
 * else the map draws its grid.
 *
 * The named states, each shot on each site as `<site>-<state>.png`: `home`,
 * `run-live` (the live run's page), `map-live`, `map-live-selected` (its
 * character clicked, so the sidebar shows its sheet), `map-live-nearby` (zoomed
 * in on it, where the units around it draw), and `map-replay` (the ended run,
 * paused halfway). `--path P` adds a shot of any path, named after it.
 * `facts.json` beside the shots holds each page's uncaught errors, console
 * errors and third-party requests. For states that need clicks, import
 * `startRig` and drive `rig.page(...)` from a script of your own.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { localRunStore } from "../runner/viewer/clickhouse";
import { createApi } from "../runner/viewer/api";
import { createRenderer } from "../runner/viewer/snapshot";
import { findChromium, launch, type Browser, type Page, type PageOptions } from "./shots/cdp";
import { writeFixture, type Fixture } from "./shots/fixture";
import { describeReport, emptyState, publishPass, type ObjectStore } from "./publish-core";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DASHBOARD = join(REPO_ROOT, "dashboard");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Site = "private" | "public";

export interface RigOptions {
  /** Where the shots go; the rig's own files are under `<out>/.rig`. */
  out: string;
  /** Run directories to copy in instead of the fixture. */
  runs?: readonly string[];
  wowhead?: "stub" | "real";
  log?: (line: string) => void;
}

export interface Rig {
  out: string;
  runsDir: string;
  privateUrl: string;
  publicUrl: string;
  bucketUrl: string;
  /** A run the viewer reads as live, and one that ended, when the runs have them. */
  live: string | null;
  ended: string | null;
  /** The live run's character, as the map's sidebar names it. */
  liveCharacter: string | null;
  /** A page on one site, its third parties answered as the rig was told. */
  page(site: Site, opts?: Partial<PageOptions>): Promise<RigPage>;
  /** Another publisher pass, e.g. after the live run moved; the engine's report line. */
  publish(): Promise<string>;
  close(): Promise<void>;
}

export interface RigPage {
  page: Page;
  /** Go to a path on this page's site and wait for `selector`; false when it never matched. */
  open(path: string, selector?: string, settleMs?: number): Promise<boolean>;
  /** A replay's playhead to a fraction of its span (the map's scrubber). */
  seek(fraction: number): Promise<boolean>;
  /** Click the map outward from its centre until the sidebar names `character`; false when no click did. */
  select(character: string): Promise<boolean>;
  /** Wheel the map in on its centre by `steps` notches (each about ×1.57); false when there is no map. */
  zoom(steps: number): Promise<boolean>;
  /** `<out>/<name>.png`, of the viewport or of the first match of `selector`. */
  shot(name: string, selector?: string): Promise<string>;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

function fileResponse(root: string, path: string, cors: boolean): Response | null {
  const p = normalize(join(root, decodeURIComponent(path)));
  if (!p.startsWith(root) || !existsSync(p) || !statSync(p).isFile()) return null;
  const headers: Record<string, string> = { "content-type": TYPES[extname(p)] ?? "application/json", "cache-control": "no-store" };
  if (cors) headers["access-control-allow-origin"] = "*";
  return new Response(Bun.file(p), { headers });
}

/** A vite build of the dashboard into `outDir`, with exactly the flags given and no VITE_WRATHBENCH_* from this shell. */
async function build(outDir: string, flags: Record<string, string>): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("VITE_WRATHBENCH_")) env[k] = v;
  const p = Bun.spawn(["bunx", "vite", "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
    cwd: DASHBOARD,
    env: { ...env, ...flags },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`the dashboard build into ${outDir} failed:\n${err.slice(-2000)}`);
}

/** Which of the runs read as live and as ended, from their rows. */
async function pick(handle: (req: Request) => Promise<Response>): Promise<{ live: string | null; ended: string | null; liveCharacter: string | null }> {
  const res = await handle(new Request("http://127.0.0.1/api/runs"));
  const body = (await res.json()) as unknown;
  const rows = (Array.isArray(body) ? body : ((body as { runs?: unknown[] }).runs ?? [])) as {
    runId?: string;
    live?: boolean;
    terminationReason?: string | null;
    character?: string | null;
  }[];
  const live = rows.find((r) => r.live === true);
  return {
    live: live?.runId ?? null,
    ended: rows.find((r) => r.terminationReason != null)?.runId ?? null,
    liveCharacter: live?.character ?? null,
  };
}

export async function startRig(opts: RigOptions): Promise<Rig> {
  const log = opts.log ?? (() => {});
  const out = resolve(opts.out);
  const work = join(out, ".rig");
  rmSync(work, { recursive: true, force: true });
  const runsDir = join(work, "runs");
  const bucketDir = join(work, "bucket");
  const distPrivate = join(work, "dist-private");
  const distPublic = join(work, "dist-public");
  const configDbPath = join(work, "config.sqlite");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(bucketDir, { recursive: true });
  // Nothing here may read the operator's stores, whatever .env says.
  delete process.env["CLICKHOUSE_URL"];
  process.env["WRATHBENCH_CONFIG_DB"] = configDbPath;

  let fixture: Fixture | null = null;
  if (opts.runs === undefined || opts.runs.length === 0) {
    fixture = writeFixture(runsDir);
    await fixture.ready;
    log(`fixture runs: ${fixture.live} (live), ${fixture.ended} (ended)`);
  } else {
    for (const src of opts.runs) {
      const from = resolve(src);
      if (!existsSync(join(from, "meta.json"))) throw new Error(`${src} is not a run directory (no meta.json)`);
      cpSync(from, join(runsDir, basename(from)), { recursive: true, filter: (p) => basename(p) !== "heartbeat" });
    }
    log(`copied ${opts.runs.length} run(s) into ${runsDir}`);
  }

  const minimap = join(REPO_ROOT, "data", "minimap");
  const tilesDir = existsSync(minimap) ? minimap : join(work, "no-tiles");
  const privateApi = createApi({
    runsDir,
    tilesDir,
    dashboardDir: distPrivate,
    moduleUrl: "http://127.0.0.1:1",
    store: localRunStore(runsDir),
    configDbPath,
    allowedHosts: [],
  });
  const publicApi = createApi({ runsDir, tilesDir: join(work, "no-tiles"), publicMode: true, moduleUrl: "http://127.0.0.1:1", store: localRunStore(runsDir), configDbPath });
  const renderer = createRenderer({ runsDir, api: publicApi, configDbPath });
  const store: ObjectStore = {
    put: async (path, body) => {
      const p = join(bucketDir, path);
      mkdirSync(dirname(p), { recursive: true });
      await Bun.write(p, body);
    },
    delete: async (path) => rmSync(join(bucketDir, path), { force: true }),
  };
  const state = emptyState();
  const publish = async (): Promise<string> => describeReport(await publishPass(async (sink, published) => await renderer(undefined, { sink, batch: 4 }, published), store, state));

  const bucket = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/tiles/")) {
        const r = await privateApi(new Request(`http://127.0.0.1${url.pathname}`));
        const headers = new Headers(r.headers);
        headers.set("access-control-allow-origin", "*");
        return new Response(r.body, { status: r.status, headers });
      }
      return fileResponse(bucketDir, url.pathname, true) ?? Response.json({ error: "no such object" }, { status: 404, headers: { "access-control-allow-origin": "*" } });
    },
  });
  const bucketUrl = `http://127.0.0.1:${bucket.port}`;

  const t0 = performance.now();
  const [report] = await Promise.all([
    publish(),
    build(distPrivate, {}),
    build(distPublic, { VITE_WRATHBENCH_SNAPSHOT_BASE: bucketUrl, VITE_WRATHBENCH_TILES_BASE: bucketUrl }),
  ]);
  log(`built both dashboards and ran a publisher pass in ${Math.round(performance.now() - t0)} ms: ${report}`);

  const priv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 120, fetch: (req) => privateApi(req) });
  const pub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => fileResponse(distPublic, new URL(req.url).pathname, false) ?? new Response(Bun.file(join(distPublic, "index.html")), { headers: { "content-type": "text/html" } }),
  });
  const privateUrl = `http://127.0.0.1:${priv.port}`;
  const publicUrl = `http://127.0.0.1:${pub.port}`;
  const ticker = fixture === null ? null : setInterval(() => fixture!.tick(), 5_000);
  const picked = await pick(privateApi);

  let browser: Browser | null = null;
  const pages: RigPage[] = [];
  return {
    out,
    runsDir,
    privateUrl,
    publicUrl,
    bucketUrl,
    live: picked.live,
    ended: picked.ended,
    liveCharacter: picked.liveCharacter,
    publish,
    async page(site, popts = {}) {
      if (browser === null) {
        const exe = findChromium();
        if (exe === null) throw new Error("no Chromium on the PATH; set WRATHBENCH_CHROMIUM to one");
        browser = await launch(exe);
      }
      const base = site === "private" ? privateUrl : publicUrl;
      const page = await browser.newPage({ width: 1440, height: 900, scheme: "dark", wowhead: opts.wowhead ?? "stub", ...popts });
      const rp: RigPage = {
        page,
        async open(path, selector = "main", settleMs = 2_500) {
          await page.goto(`${base}${path}`);
          const ok = await page.waitFor(selector, 20_000);
          await sleep(settleMs);
          return ok;
        },
        async seek(fraction) {
          return await page.eval<boolean>(`(() => {
            const el = document.querySelector("input.scrubber");
            if (!el) return false;
            const min = Number(el.min), max = Number(el.max);
            el.value = String(Math.round(min + (max - min) * ${Math.min(1, Math.max(0, fraction))}));
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          })()`);
        },
        async select(character) {
          const box = await page.eval<{ x: number; y: number; w: number; h: number } | null>(
            `(() => { const c = document.querySelector(".map-stage canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
          );
          if (box === null) return false;
          const cx = box.x + box.w / 2;
          const cy = box.y + box.h / 2;
          const points: [number, number][] = [];
          for (let y = box.y + 12; y < box.y + box.h - 80; y += 12) for (let x = box.x + 12; x < box.x + box.w - 12; x += 12) points.push([x, y]);
          points.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
          const named = `(() => { const h = document.querySelector(".side h3"); return h ? h.textContent : ""; })()`;
          for (const [x, y] of points.slice(0, 600)) {
            await page.clickAt(x, y);
            if ((await page.eval<string>(named)).includes(character)) return true;
          }
          return false;
        },
        async zoom(steps) {
          const box = await page.eval<{ x: number; y: number } | null>(
            `(() => { const c = document.querySelector(".map-stage canvas"); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
          );
          if (box === null) return false;
          for (let i = 0; i < steps; i++) {
            await page.wheel(box.x, box.y, -300);
            await sleep(150);
          }
          return true;
        },
        async shot(name, selector) {
          const path = join(out, `${name}.png`);
          await page.screenshot(path, selector);
          return path;
        },
        async close() {
          await page.close();
        },
      };
      pages.push(rp);
      return rp;
    },
    async close() {
      if (ticker !== null) clearInterval(ticker);
      for (const p of pages.splice(0)) await p.close();
      if (browser !== null) await (browser as Browser).close();
      priv.stop(true);
      pub.stop(true);
      bucket.stop(true);
      fixture?.close();
    },
  };
}

// ------------------------------------------------------------------ the CLI

export interface State {
  name: string;
  path: string;
  /** What must be on the page before the shot. */
  wait: string;
  /** A replay paused at this fraction of its span. */
  seek?: number;
  /** A character to select on the map first. */
  select?: string;
  /** Notches to wheel the map in on its centre first. */
  zoom?: number;
}

/** The named states, for the runs the rig picked: a state whose run is missing is left out. */
export function defaultStates(live: string | null, ended: string | null, liveCharacter: string | null): State[] {
  const states: State[] = [{ name: "home", path: "/", wait: "main" }];
  if (live !== null) states.push({ name: "run-live", path: `/run/${encodeURIComponent(live)}`, wait: "main" });
  states.push({ name: "map-live", path: "/map", wait: "canvas" });
  if (liveCharacter !== null) {
    states.push({ name: "map-live-selected", path: "/map", wait: "canvas", select: liveCharacter });
    // The map opens fitted on the live character; six notches is past the nearby layer's gate and its names'.
    states.push({ name: "map-live-nearby", path: "/map", wait: "canvas", zoom: 6, select: liveCharacter });
  }
  if (ended !== null) states.push({ name: "map-replay", path: `/map?run=${encodeURIComponent(ended)}`, wait: "input.scrubber", seek: 0.5 });
  return states;
}

/** A path as a shot name: `/run/x?y=1` → `path-run-x-y-1`. */
export function pathName(path: string): string {
  const slug = path.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `path-${slug === "" ? "root" : slug}`.slice(0, 80);
}

interface Cli {
  out: string;
  runs: string[];
  paths: string[];
  sites: Site[];
  viewport: { width: number; height: number };
  scheme: "dark" | "light";
  settle: number;
  wowhead: "stub" | "real";
  serve: boolean;
}

export const USAGE = `usage: bun infra/dashboard-shots.ts [--out DIR] [--run DIR]... [--path P]... [--site private|public|both]
                                   [--viewport WxH] [--scheme dark|light] [--settle MS] [--real-wowhead] [--serve]`;

export function parseCli(argv: readonly string[], now = new Date()): Cli | { error: string } {
  const c: Cli = {
    out: join(tmpdir(), `wrathbench-shots-${now.toISOString().replace(/[:.]/g, "-")}`),
    runs: [],
    paths: [],
    sites: ["private", "public"],
    viewport: { width: 1440, height: 900 },
    scheme: "dark",
    settle: 2_500,
    wowhead: "stub",
    serve: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = (): string | undefined => argv[++i];
    if (a === "--real-wowhead") c.wowhead = "real";
    else if (a === "--serve") c.serve = true;
    else if (["--out", "--run", "--path", "--site", "--viewport", "--scheme", "--settle"].includes(a)) {
      const v = val();
      if (v === undefined) return { error: `${a} needs a value` };
      if (a === "--out") c.out = v;
      else if (a === "--run") c.runs.push(v);
      else if (a === "--path") {
        if (!v.startsWith("/")) return { error: "--path is a path on the site, starting with /" };
        c.paths.push(v);
      } else if (a === "--site") {
        if (v !== "private" && v !== "public" && v !== "both") return { error: "--site is private, public or both" };
        c.sites = v === "both" ? ["private", "public"] : [v];
      } else if (a === "--viewport") {
        const m = /^(\d{3,4})x(\d{3,4})$/.exec(v);
        if (m === null) return { error: "--viewport is WxH, e.g. 390x844" };
        c.viewport = { width: Number(m[1]), height: Number(m[2]) };
      } else if (a === "--scheme") {
        if (v !== "dark" && v !== "light") return { error: "--scheme is dark or light" };
        c.scheme = v;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 60_000) return { error: "--settle is 0..60000 ms" };
        c.settle = n;
      }
    } else return { error: `unknown argument ${a}` };
  }
  return c;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const c = parseCli(argv);
  if ("error" in c) {
    console.error(`dashboard shots: ${c.error}\n${USAGE}`);
    return 2;
  }
  mkdirSync(c.out, { recursive: true });
  const rig = await startRig({ out: c.out, runs: c.runs, wowhead: c.wowhead, log: (l) => console.log(l) });
  console.log(`private ${rig.privateUrl} · public ${rig.publicUrl} · bucket ${rig.bucketUrl}`);
  if (c.serve) {
    console.log("serving until Ctrl-C; a publisher pass every 60 s keeps the public site in step");
    const pass = setInterval(() => void rig.publish().catch((e: unknown) => console.error(String(e))), 60_000);
    await new Promise<void>((done) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => done());
    });
    clearInterval(pass);
    await rig.close();
    return 0;
  }
  const states: State[] = [...defaultStates(rig.live, rig.ended, rig.liveCharacter), ...c.paths.map((p) => ({ name: pathName(p), path: p, wait: "main" }))];
  const facts: Record<string, unknown> = {};
  let failed = 0;
  try {
    for (const site of c.sites) {
      for (const st of states) {
        const name = `${site}-${st.name}`;
        const p = await rig.page(site, { ...c.viewport, scheme: c.scheme });
        const found = await p.open(st.path, st.wait, c.settle);
        const seeked = st.seek === undefined ? undefined : await p.seek(st.seek);
        const zoomed = st.zoom === undefined ? undefined : await p.zoom(st.zoom);
        const selected = st.select === undefined ? undefined : await p.select(st.select);
        if (seeked === true || zoomed === true || selected === true) await sleep(c.settle);
        const file = await p.shot(name);
        facts[name] = { path: st.path, found, ...(seeked !== undefined ? { seeked } : {}), ...(selected !== undefined ? { selected } : {}), ...p.page.facts };
        const trouble = [
          found ? null : `never saw ${st.wait}`,
          seeked === false ? "no scrubber to seek" : null,
          zoomed === false ? "no map to zoom" : null,
          selected === false ? `no click selected ${st.select}` : null,
          p.page.facts.errors.length > 0 ? `${p.page.facts.errors.length} page error(s)` : null,
        ].filter(Boolean);
        if (trouble.length > 0) failed++;
        console.log(`${file}${trouble.length > 0 ? `  (${trouble.join(", ")})` : ""}`);
        await p.close();
      }
    }
  } finally {
    writeFileSync(join(c.out, "facts.json"), `${JSON.stringify(facts, null, 1)}\n`);
    await rig.close();
  }
  console.log(`${join(c.out, "facts.json")}: each page's errors, console errors and third-party requests`);
  return failed > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
