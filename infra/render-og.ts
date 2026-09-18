#!/usr/bin/env bun
/**
 * Render the social card to `dashboard/public/og.png`, and print its stamp.
 *
 *   bun infra/render-og.ts            # render, print the content stamp on stdout
 *   bun infra/render-og.ts --svg out.svg   # also keep the SVG, for looking at
 *   bun infra/render-og.ts --width 400 --out /tmp/small.png  # a downscale to check
 *
 * A crawler fetches the image with no JavaScript, so the card is a raster made
 * at ship time rather than the live chart. `infra/deploy-dashboard.sh` runs
 * this before the snapshot-mode build and feeds the printed stamp to the build
 * as `VITE_WRATHBENCH_OG_STAMP`, which is what changes the image's URL when
 * and only when the picture changes — Discord caches a card by URL and has no
 * purge.
 *
 * The data is the snapshot renderer's own `ladder-e90.json`, not a live poll:
 * that is the artifact the public build reads, so the picture and the
 * published numbers cannot disagree. Env is `publish-dashboard.ts`'s, because
 * it is the same renderer:
 *   WRATHBENCH_RUNS_DIR       default data/runs
 *   WRATHBENCH_CONFIG_DB      the config store; default $WRATHBENCH_DATA/config.sqlite, else data/config.sqlite
 *
 * Rasterising is `@resvg/resvg-js` (MPL-2.0), a napi binding to the Rust
 * resvg. Bun has no rasteriser and no canvas, and the only other thing on the
 * host that could do it is an unpinned Chromium — a browser is not a build
 * dependency this repo is willing to pin.
 *
 * One caveat worth knowing before shipping from somewhere other than the lab:
 * the wordmark is the only element that depends on the build host, since
 * resvg resolves `Helvetica, Arial, sans-serif` through the system font
 * database and silently draws nothing when it matches none. A card rendered in
 * a bare container would come out wordmarkless rather than failing. Everything
 * else is geometry and embedded assets.
 *
 * Logos are resolved here rather than in `dashboard/src/lib/og.ts`: the
 * dashboard reads them through `import.meta.glob`, which exists only under
 * Vite. Same assets, same `familyOf`, read off disk.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { ResultRun } from "../runner/viewer/api-types";
import { createRenderer } from "../runner/viewer/snapshot";
import { HOME_EPISODE } from "../dashboard/src/lib/homeladder";
import { familyOf } from "../dashboard/src/lib/lineup";
import { OG_H, OG_W, ogSvgOf } from "../dashboard/src/lib/og";

const ROOT = join(import.meta.dirname, "..");
const LOGO_DIR = join(ROOT, "dashboard/src/assets/model-logos");
const OUT = join(ROOT, "dashboard/public/og.png");

function fail(message: string): never {
  console.error(`render-og: ${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ flags */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const out = flag("--out") ?? OUT;
const svgOut = flag("--svg");
const width = Number(flag("--width") ?? OG_W);
if (!Number.isFinite(width) || width <= 0) fail(`--width wants a positive number, got ${flag("--width")}`);

/* ------------------------------------------------------------------ logos */

/**
 * family id → the asset as a data URI, exactly the form `logoHrefOf` builds.
 *
 * An empty directory is legitimate — a checkout that has not run
 * `bun run model-logos` has no assets — and every mark is then a plain disc,
 * the same fallback the live chart takes for a family it does not know.
 */
function logoHrefs(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(LOGO_DIR)) return map;
  for (const file of readdirSync(LOGO_DIR)) {
    if (!file.endsWith(".svg")) continue;
    const svg = readFileSync(join(LOGO_DIR, file), "utf8");
    map.set(file.slice(0, -".svg".length), `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  }
  return map;
}

/* ------------------------------------------------------------------- data */

/** The ladder the homepage draws, straight out of a snapshot pass. */
async function ladderRuns(): Promise<ResultRun[]> {
  const runsDir = Bun.env.WRATHBENCH_RUNS_DIR ?? "data/runs";
  if (!existsSync(runsDir)) fail(`no runs directory at ${runsDir} — set WRATHBENCH_RUNS_DIR`);
  const render = createRenderer({ runsDir });
  const result = await render();
  const artifact = result.artifacts.find((a) => a.path.endsWith(`/ladder-${HOME_EPISODE}.json`));
  if (artifact === undefined) fail(`the snapshot pass produced no ladder-${HOME_EPISODE}.json`);
  const body = JSON.parse(artifact.body) as { runs?: ResultRun[] };
  return body.runs ?? [];
}

/* ------------------------------------------------------------------ render */

const hrefs = logoHrefs();
const runs = await ladderRuns();
const svg = ogSvgOf(runs, {
  logoHref: (model) => {
    const family = familyOf(model);
    return family === null ? null : hrefs.get(family.id) ?? null;
  },
});
if (svgOut !== undefined) await Bun.write(svgOut, svg);

const png = new Resvg(svg, { fitTo: { mode: "width", value: Math.round(width) } }).render().asPng();
await Bun.write(out, png);

/*
 * The stamp is the picture's own content hash, so a redeploy that changed
 * nothing leaves the card's URL alone and a crawler keeps its cached copy —
 * and a redeploy that moved a point changes it.
 */
const stamp = new Bun.CryptoHasher("sha256").update(png).digest("hex").slice(0, 8);
console.error(
  `render-og: ${runs.length} runs → ${out} (${Math.round(width)}×${Math.round((width * OG_H) / OG_W)}, ${(
    png.length / 1024
  ).toFixed(0)} KiB)`,
);
console.log(stamp);
