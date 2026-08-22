#!/usr/bin/env bun
/**
 * Build the searchable wiki bundle from a local dump.
 *
 *   bun wiki/src/build.ts <dump.7z|dump.xml> [--out data/wiki/bundle.sqlite]
 *
 * The archive is streamed through `7z x -so`; the 24 GB XML is never written to
 * disk. The bundle is written to a temp file beside the destination and renamed
 * into place, so a rebuild either replaces the bundle or leaves it untouched.
 */

import { Database } from "bun:sqlite";
import { renameSync, unlinkSync, statSync, mkdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import {
  DEFAULT_BUNDLE_PATH,
  applyBuildPragmas,
  assertFts5,
  createIndexes,
  createSchema,
  makeWriter,
  setMeta,
} from "./bundle";
import { extractCoords } from "./coords";
import { extractIds } from "./ids";
import { extractQuest } from "./quests";
import { markEraSections } from "./era";
import { DEFAULT_NAMESPACES, decodeUtf8, parsePages, type ParseStats } from "./parse";
import { redirectTarget, stripWikitext } from "./strip";

const NS_NAMES: Record<number, string> = {
  0: "main",
  14: "Category",
  116: "Portal",
  118: "Quest",
};

interface Args {
  dump: string;
  out: string;
  maxPages: number;
}

function parseArgs(argv: string[]): Args {
  let dump = "";
  let out = DEFAULT_BUNDLE_PATH;
  let maxPages = Infinity;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") out = argv[++i] ?? out;
    else if (arg === "--max-pages") maxPages = Number.parseInt(argv[++i] ?? "0", 10);
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else dump = arg;
  }
  if (dump === "") {
    throw new Error("usage: bun wiki/src/build.ts <dump.7z|dump.xml> [--out path] [--max-pages n]");
  }
  return { dump, out, maxPages };
}

/** Byte stream of the dump XML, decompressing on the fly when needed. */
function openDump(path: string): {
  bytes: AsyncIterable<Uint8Array>;
  done: () => Promise<void>;
  cancel: () => void;
} {
  if (path.endsWith(".xml")) {
    return { bytes: Bun.file(path).stream(), done: async () => {}, cancel: () => {} };
  }
  const proc = Bun.spawn(["7z", "x", "-so", "-bso0", "-bsp0", path, "*.xml"], {
    stdout: "pipe",
    stderr: "inherit",
  });
  return {
    bytes: proc.stdout,
    done: async () => {
      const code = await proc.exited;
      if (code !== 0) throw new Error(`7z exited with ${code}`);
    },
    cancel: () => {
      proc.kill();
    },
  };
}

function fmtBytes(n: number): string {
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(0)} MiB`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  // Fail before spending an hour on the stream.
  const probe = new Database(":memory:");
  assertFts5(probe);
  probe.close();

  const outDir = dirname(args.out);
  mkdirSync(outDir, { recursive: true });
  const tmpPath = join(outDir, `.${basename(args.out)}.tmp-${process.pid}`);
  try {
    unlinkSync(tmpPath);
  } catch {
    /* not there */
  }

  const db = new Database(tmpPath, { create: true });
  applyBuildPragmas(db);
  assertFts5(db);
  createSchema(db);
  const writer = makeWriter(db);

  const perNamespace: Record<number, number> = {};
  let pagesSeen = 0;
  let pagesKept = 0;
  let redirects = 0;
  let empties = 0;
  let bytes = 0;
  let charsKept = 0;
  let coordRows = 0;
  let idRows = 0;
  let questRows = 0;
  let stoppedEarly = false;
  const parseStats: ParseStats = { pagesSkipped: 0 };

  const started = Date.now();
  let lastLog = started;
  const logProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLog < 15_000) return;
    lastLog = now;
    const elapsed = (now - started) / 1000;
    const rate = bytes / 1024 ** 2 / Math.max(elapsed, 0.001);
    console.log(
      `[${fmtDuration(now - started)}] ${fmtBytes(bytes)} read (${rate.toFixed(0)} MiB/s), ` +
        `${pagesSeen + parseStats.pagesSkipped} pages seen ` +
        `(${parseStats.pagesSkipped} in dropped namespaces), ${pagesKept} kept, ` +
        `${redirects} redirects`,
    );
  };

  const { bytes: stream, done, cancel } = openDump(args.dump);
  const chunks = decodeUtf8(stream, (total) => {
    bytes = total;
  });

  console.log(`building ${args.out} from ${args.dump}`);
  try {
    for await (const page of parsePages(chunks, DEFAULT_NAMESPACES, parseStats)) {
      pagesSeen++;
      const target = page.redirectAttr ?? redirectTarget(page.wikitext);
      if (target !== null) {
        redirects++;
        writer.addRedirect(page.title, target, page.ns);
      } else {
        // Coords and ids come off the RAW wikitext before the strip destroys
        // the templates that carry them.
        const coords = extractCoords(page.wikitext);
        const ids = extractIds(page.wikitext);
        const quest = extractQuest(page.wikitext);
        // Era sections are marked in the wikitext, before the strip removes the
        // templates and headings that identify them (era.ts).
        const text = stripWikitext(markEraSections(page.wikitext));
        if (text.length === 0) {
          empties++;
        } else {
          writer.addPage(page.title, page.ns, text, coords, ids, quest);
          pagesKept++;
          charsKept += text.length;
          coordRows += coords.length;
          idRows += ids.length;
          if (quest !== null) questRows++;
          perNamespace[page.ns] = (perNamespace[page.ns] ?? 0) + 1;
        }
      }
      logProgress();
      if (pagesSeen >= args.maxPages) {
        stoppedEarly = true;
        break;
      }
    }
    writer.flush();
    if (stoppedEarly) cancel();
    else await done();
  } catch (err) {
    writer.flush();
    db.close();
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    throw err;
  }

  logProgress(true);
  console.log("building indexes …");
  createIndexes(db);
  db.run("INSERT INTO pages_fts(pages_fts) VALUES('optimize')");

  const elapsedMs = Date.now() - started;
  setMeta(db, {
    source: basename(args.dump),
    built_at: new Date().toISOString(),
    namespaces: [...DEFAULT_NAMESPACES].join(","),
    pages_seen: String(pagesSeen + parseStats.pagesSkipped),
    pages_in_namespaces: String(pagesSeen),
    pages_skipped_namespace: String(parseStats.pagesSkipped),
    pages_kept: String(pagesKept),
    redirects: String(redirects),
    empty_pages: String(empties),
    coord_rows: String(coordRows),
    id_rows: String(idRows),
    quest_rows: String(questRows),
    bytes_read: String(bytes),
    build_ms: String(elapsedMs),
    schema_version: "4",
  });
  db.run("PRAGMA optimize");
  db.close();

  renameSync(tmpPath, args.out);
  const size = statSync(args.out).size;

  console.log("");
  console.log(`bundle:      ${args.out} (${fmtBytes(size)})`);
  console.log(`read:        ${fmtBytes(bytes)} of XML in ${fmtDuration(elapsedMs)}`);
  console.log(`pages seen:  ${pagesSeen + parseStats.pagesSkipped}`);
  console.log(`  in ns:     ${pagesSeen}`);
  console.log(`  dropped:   ${parseStats.pagesSkipped} (namespace)`);
  console.log(`pages kept:  ${pagesKept} (${fmtBytes(charsKept)} of plain text)`);
  console.log(`coord rows:  ${coordRows}`);
  console.log(`id rows:     ${idRows}`);
  console.log(`redirects:   ${redirects}`);
  console.log(`empty:       ${empties}`);
  for (const ns of Object.keys(perNamespace).map(Number).sort((a, b) => a - b)) {
    console.log(`  ns ${String(ns).padStart(3)} ${(NS_NAMES[ns] ?? "?").padEnd(9)} ${perNamespace[ns]}`);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
