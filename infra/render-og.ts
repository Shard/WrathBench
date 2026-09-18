#!/usr/bin/env bun
/**
 * Render the social card to `dashboard/public/og.png`, and print its stamp.
 *
 *   bun infra/render-og.ts            # render, print the content stamp on stdout
 *   bun infra/render-og.ts --upload   # …and PUT it to the public bucket as well
 *   bun infra/render-og.ts --svg out.svg   # also keep the SVG, for looking at
 *   bun infra/render-og.ts --width 400 --out /tmp/small.png  # a downscale to check
 *
 * A crawler fetches the image with no JavaScript, so the card is a raster
 * rather than the live chart. **The publisher is what keeps it current** since
 * 2026-09-18: `infra/publish-dashboard.ts` renders the same picture from the
 * ladder it just published and PUTs it to `v1/og.png` every pass, which is the
 * URL `og:image` names. This script is the ship-time half — it writes the file
 * the app origin serves, and with `--upload` it seeds the bucket so a first
 * ship does not have to wait a publish interval for its own card to exist.
 *
 * The data is the snapshot renderer's own `ladder-e90.json`, not a live poll:
 * that is the artifact the public build reads, so the picture and the
 * published numbers cannot disagree. Note what that means for *this* CLI — it
 * renders whatever `WRATHBENCH_RUNS_DIR` holds **on the shipping machine**, so
 * a ship from a lagging checkout used to publish a lagging card. The publisher
 * runs beside the real runs tree and has no such problem, which is the other
 * reason the loop owns the picture now.
 *
 * Env is `publish-dashboard.ts`'s, because it is the same renderer:
 *   WRATHBENCH_RUNS_DIR       default data/runs
 *   WRATHBENCH_CONFIG_DB      the config store; default $WRATHBENCH_DATA/config.sqlite, else data/config.sqlite
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET, S3_ENDPOINT  (--upload only)
 *
 * Rasterising is `@resvg/resvg-js` (MPL-2.0), a napi binding to the Rust
 * resvg. Bun has no rasteriser and no canvas, and the only other thing on the
 * host that could do it is an unpinned Chromium — a browser is not a build
 * dependency this repo is willing to pin. The drawing, the logo resolution and
 * the font check all live in `infra/og-render.ts`, shared with the publisher.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "bun";
import type { ResultRun } from "../runner/viewer/api-types";
import { createRenderer } from "../runner/viewer/snapshot";
import { HOME_EPISODE } from "../dashboard/src/lib/homeladder";
import { OG_W } from "../dashboard/src/lib/og";
import { heightAt, OG_KEY, ogSvgWithLogos, renderOgPng } from "./og-render";

const ROOT = join(import.meta.dirname, "..");
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
const upload = args.includes("--upload");
const width = Number(flag("--width") ?? OG_W);
if (!Number.isFinite(width) || width <= 0) fail(`--width wants a positive number, got ${flag("--width")}`);

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

const runs = await ladderRuns();
if (svgOut !== undefined) await Bun.write(svgOut, ogSvgWithLogos(runs));

let card;
try {
  card = renderOgPng(runs, { width });
} catch (e) {
  // The font check throws here rather than letting a textless card ship: the
  // wordmark, the axis captions and every model name would simply be absent.
  fail(e instanceof Error ? e.message : String(e));
}
await Bun.write(out, card.png);

if (upload) {
  // Seeding the bucket, not owning it: the publisher overwrites this on its
  // next pass. Missing credentials are a warning and not a failure — a ship
  // from a machine with no R2 key pair still produces a correct site, it just
  // leaves the first card to the publisher.
  const missing = (["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT"] as const).filter(
    (n) => (Bun.env[n] ?? "") === "" && (Bun.env[n.replace("S3_", "AWS_")] ?? "") === "",
  );
  if (missing.length > 0) {
    console.error(`render-og: not uploading — ${missing.join(", ")} unset; the publisher will write ${OG_KEY} on its next pass`);
  } else {
    await new S3Client().write(OG_KEY, card.png, { type: "image/png" });
    console.error(`render-og: uploaded ${OG_KEY} (${Bun.env.S3_BUCKET ?? Bun.env.AWS_BUCKET})`);
  }
}

/*
 * The stamp is the picture's own content hash, so a redeploy that changed
 * nothing leaves the card's URL alone and a crawler keeps its cached copy —
 * and a redeploy that moved a point changes it. It is a cache key and not an
 * identity: the publisher's next pass replaces the bytes at that URL without
 * changing it, which is the whole point of the loop owning the picture.
 */
console.error(
  `render-og: ${card.runs} runs → ${out} (${Math.round(width)}×${heightAt(width)}, ${(card.png.length / 1024).toFixed(0)} KiB)`,
);
console.log(card.stamp);
