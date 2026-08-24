#!/usr/bin/env bun
/**
 * Build the searchable wiki bundle from a local dump.
 *
 *   bun wiki/src/build.ts <dump.7z|dump.xml> [--out data/wiki/bundle.sqlite]
 *                                             [--era-cutoff 2010-10-12T00:00:00Z]
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
  assertUniquePages,
  createIndexes,
  createSchema,
  makeWriter,
  setMeta,
} from "./bundle";
import { extractCoords } from "./coords";
import { extractIds } from "./ids";
import { extractQuest } from "./quests";
import { admitPage, type AdmitReason } from "./post-wrath";
import { assertCanaries } from "./canary";
import { DEFAULT_ERA_CUTOFF, dropOutOfWorldOnly, dropPostWrath } from "./wrath-only";
import { DEFAULT_NAMESPACES, decodeUtf8, parsePages, type ParseStats, type WikiPage } from "./parse";
import { stripWikitext } from "./strip";

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
  eraCutoff: string;
  /**
   * Run the canary check before the bundle is renamed into place. On by default
   * for a full build and off for a `--max-pages` smoke build, whose truncated
   * page set cannot contain the capitals except by luck.
   */
  canary: boolean;
}

/**
 * The cutoff is compared against the dump's `<timestamp>` as a string, so a
 * value that is not a full ISO-8601 Z instant would compare wrongly and quietly
 * send every page down the fallback path — a bundle that looks built. Reject it
 * here, before the stream starts.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseArgs(argv: string[]): Args {
  let dump = "";
  let out = DEFAULT_BUNDLE_PATH;
  let maxPages = Infinity;
  let eraCutoff = DEFAULT_ERA_CUTOFF;
  let canary: boolean | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") out = argv[++i] ?? out;
    else if (arg === "--max-pages") maxPages = Number.parseInt(argv[++i] ?? "0", 10);
    else if (arg === "--era-cutoff") eraCutoff = argv[++i] ?? eraCutoff;
    else if (arg === "--no-canary") canary = false;
    else if (arg === "--canary") canary = true;
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else dump = arg;
  }
  if (dump === "") {
    throw new Error(
      "usage: bun wiki/src/build.ts <dump.7z|dump.xml> [--out path] [--max-pages n] " +
        "[--era-cutoff YYYY-MM-DDTHH:MM:SSZ] [--no-canary]",
    );
  }
  if (!ISO_INSTANT.test(eraCutoff)) {
    throw new Error(
      `--era-cutoff must be a full ISO-8601 UTC instant like ${DEFAULT_ERA_CUTOFF}, got ${eraCutoff}`,
    );
  }
  return { dump, out, maxPages, eraCutoff, canary: canary ?? !Number.isFinite(maxPages) };
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
  /**
   * Pages in the bundle with no prose: an infobox-only page, and now a page the
   * out-of-world trim emptied. They are rows, not drops — the title, the ids,
   * the coords and the quest infobox are still this world's.
   */
  let empties = 0;
  /**
   * The subset of `empties` that had prose before the out-of-world trim took it.
   * A page emptied by the ERA cuts is not here: it is dropped as post-Wrath.
   */
  let emptiedByTrim = 0;
  let bytes = 0;
  let charsKept = 0;
  let coordRows = 0;
  let idRows = 0;
  let questRows = 0;
  let eraSwapped = 0;
  /**
   * Kept pages that carried a post-Wrath signal and were kept anyway, because
   * they predate the Cataclysm beta. A tag on a subset of `pre_cutoff`, never a
   * sixth bucket: it is deliberately outside the accounting identity.
   */
  let preAnnouncementProtected = 0;
  let sectionsDropped = 0;
  let paragraphsDropped = 0;
  /** Out-of-world sections cut inside a surviving page, and what they were. */
  let sectionsTrimmed = 0;
  const sectionsTrimmedBy: Record<string, number> = {};
  let redirectsDangling = 0;
  /** One counter per `admitPage` reason; the two admitting reasons are the kept pages. */
  const reasons: Record<AdmitReason, number> = {
    pre_cutoff: 0,
    post_cutoff_wrath_signal: 0,
    dropped_post_cutoff: 0,
    dropped_post_wrath: 0,
    dropped_meta: 0,
  };
  /**
   * Redirects are written after the stream, not during: a redirect whose target
   * did not survive the Wrath cutoff points at nothing, and whether the target
   * survived is not known until every page has been seen. With `--max-pages`
   * the stream stops early, so a smoke build drops every redirect whose target
   * it never reached; its `redirects` count is not comparable to a full build's.
   */
  const pendingRedirects: { source: string; target: string; ns: number }[] = [];
  const keptTitles = new Set<string>();
  let stoppedEarly = false;
  let distinctKeys = 0;
  const parseStats: ParseStats = { pagesSkipped: 0, blocksSeen: 0 };

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
        `${parseStats.blocksSeen + parseStats.pagesSkipped} page blocks seen ` +
        `(${parseStats.pagesSkipped} in dropped namespaces), ${pagesKept} kept, ` +
        `${redirects} redirects`,
    );
  };

  const { bytes: stream, done, cancel } = openDump(args.dump);
  const chunks = decodeUtf8(stream, (total) => {
    bytes = total;
  });

  /**
   * Write one admitted page. `source` is the revision its prose comes from —
   * the pre-cutoff one, or the newest for a page admitted on an explicit Wrath
   * signal. Structured fields always come off the newest revision, where a
   * decade of corrections lives and where 30% of the coordinates only exist.
   */
  const keep = (page: WikiPage, source: string, reason: AdmitReason, protectedPage = false): void => {
    // Coords and ids come off the RAW wikitext before the strip destroys the
    // templates that carry them.
    const coords = extractCoords(page.wikitext);
    const ids = extractIds(page.wikitext);
    const quest = extractQuest(page.wikitext);
    // Post-Wrath sections and paragraphs go before the strip, which would
    // otherwise remove the templates and headings that identify them.
    const cut = dropPostWrath(source);
    sectionsDropped += cut.sectionsDropped;
    paragraphsDropped += cut.paragraphsDropped;
    sectionsTrimmed += cut.sectionsTrimmed;
    for (const [heading, n] of Object.entries(cut.sectionsTrimmedBy)) {
      sectionsTrimmedBy[heading] = (sectionsTrimmedBy[heading] ?? 0) + n;
    }
    const text = stripWikitext(cut.text);
    let emptied = false;
    if (text.length === 0) {
      // Which cut emptied it decides whether the page is dropped or kept.
      //
      // Only the ERA cuts are evidence about the page's world: prose that would
      // have survived the out-of-world trim and did not survive the era cuts
      // belongs to a later world, and the page goes. The trim is not evidence of
      // anything — a page whose body was an infobox and an external-links list
      // is still this world's item, and its title, ids, coords and quest infobox
      // are still the right answer to a query. So it stays, as an empty row,
      // beside the page that never had prose at all.
      const trimmedOnly = stripWikitext(dropOutOfWorldOnly(source));
      if (trimmedOnly.length > 0) {
        reasons.dropped_post_wrath++;
        return;
      }
      const hadProse = stripWikitext(source).length > 0;
      emptied = true;
      empties++;
      if (hadProse) emptiedByTrim++;
    }
    writer.addPage(page.title, page.ns, text, coords, ids, quest);
    if (!emptied) {
      // An empty row is counted under `empty_pages` and nowhere else: the
      // admitting reasons are about pages with prose, and the accounting
      // identity would double-count it.
      reasons[reason]++;
      // Counted here rather than at decision time: a protected page can still be
      // emptied by the cuts above, and the counter is a subset of `pre_cutoff`.
      if (protectedPage) preAnnouncementProtected++;
      // Only meaningful for a pre-cutoff admission: a page admitted on a Wrath
      // signal has one revision to read, so its prose is never "swapped".
      if (reason === "pre_cutoff" && page.eraTimestamp !== page.timestamp) eraSwapped++;
    }
    keptTitles.add(page.title.toLowerCase());
    pagesKept++;
    charsKept += text.length;
    coordRows += coords.length;
    idRows += ids.length;
    if (quest !== null) questRows++;
    perNamespace[page.ns] = (perNamespace[page.ns] ?? 0) + 1;
  };

  console.log(`building ${args.out} from ${args.dump}`);
  try {
    for await (const page of parsePages(chunks, DEFAULT_NAMESPACES, parseStats, args.eraCutoff)) {
      pagesSeen++;
      // Redirect-ness is decided by the Wrath snapshot: the newest pre-cutoff
      // revision. A page that redirects today but was an article in 2010 is an
      // article here, and one that was a redirect then stays one whatever it
      // became later. A page with no pre-cutoff revision at all is not in this
      // world's wiki, redirect or not.
      const target = page.eraRedirectTarget;
      if (target !== null) {
        pendingRedirects.push({ source: page.title, target, ns: page.ns });
      } else if (!page.hasEraRevision) {
        // No revision before the cutoff. It may still be a page about this
        // world, written late; `admitPage` decides on the newest revision.
        const decision = admitPage({
          title: page.title,
          eraWikitext: null,
          newestWikitext: page.wikitext,
          firstRevisionAt: page.firstRevisionAt,
        });
        if (!decision.admit) {
          reasons[decision.reason]++;
        } else {
          keep(page, page.wikitext, decision.reason);
        }
      } else {
        const decision = admitPage({
          title: page.title,
          eraWikitext: page.eraWikitext,
          newestWikitext: page.wikitext,
          firstRevisionAt: page.firstRevisionAt,
        });
        if (!decision.admit) {
          reasons[decision.reason]++;
        } else {
          // A page with pre-cutoff revisions that all failed hygiene has no
          // prose to index; it is not a Wrath page for our purposes. `admitPage`
          // has already counted this case as `dropped_post_cutoff`-shaped, but
          // the reason it returns is about the newest revision, so the counter
          // is set here.
          const source = page.eraWikitext;
          if (source === null) reasons.dropped_post_cutoff++;
          else keep(page, source, decision.reason, decision.preAnnouncementProtected === true);
        }
      }
      logProgress();
      if (pagesSeen >= args.maxPages) {
        stoppedEarly = true;
        break;
      }
    }
    // Redirects, now that the surviving titles are known. A chain is walked
    // with the same bound `resolveTitle` uses, so a redirect to a redirect to a
    // page still lands; one that ends at a dropped page is dropped with it.
    const targets = new Map<string, string>();
    for (const r of pendingRedirects) targets.set(r.source.toLowerCase(), r.target);
    for (const r of pendingRedirects) {
      let current = r.target.toLowerCase();
      let landed = false;
      for (let hop = 0; hop < 6; hop++) {
        if (keptTitles.has(current)) {
          landed = true;
          break;
        }
        const next = targets.get(current);
        if (next === undefined) break;
        current = next.toLowerCase();
      }
      if (landed) {
        writer.addRedirect(r.source, r.target, r.ns);
        redirects++;
      } else {
        redirectsDangling++;
      }
    }
    writer.flush();
    if (stoppedEarly) cancel();
    else await done();
    distinctKeys = assertUniquePages(db);
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
    // A `<page>` block is not a page: a long history is several blocks of one
    // page, so blocks seen exceeds pages seen.
    page_blocks_seen: String(parseStats.blocksSeen + parseStats.pagesSkipped),
    page_blocks_skipped_namespace: String(parseStats.pagesSkipped),
    pages_in_namespaces: String(pagesSeen),
    pages_kept: String(pagesKept),
    pages_distinct_keys: String(distinctKeys),
    redirects: String(redirects),
    // Rows with no prose, and how many of them lost it to the out-of-world trim
    // rather than never having had any. A subset of `empty_pages`, not a bucket
    // of its own: do not add it to the sum below.
    empty_pages: String(empties),
    pages_emptied_by_trim: String(emptiedByTrim),
    coord_rows: String(coordRows),
    id_rows: String(idRows),
    quest_rows: String(questRows),
    era_cutoff: args.eraCutoff,
    // Kept pages whose prose came from an older revision than the structured
    // fields did.
    pages_era_swapped: String(eraSwapped),
    // Kept pages that carried a post-Wrath signal and were kept because they
    // predate the Cataclysm beta (`CATACLYSM_ANNOUNCED`). A subset of
    // `pages_pre_cutoff`, not a bucket of its own: do not add it to the sum.
    pages_pre_announcement_protected: String(preAnnouncementProtected),
    // Why each non-redirect page is in the bundle or is not (`post-wrath.ts`).
    // These five plus `empty_pages` account for every non-redirect page seen.
    pages_pre_cutoff: String(reasons.pre_cutoff),
    pages_post_cutoff_wrath_signal: String(reasons.post_cutoff_wrath_signal),
    pages_dropped_post_cutoff: String(reasons.dropped_post_cutoff),
    pages_dropped_post_wrath: String(reasons.dropped_post_wrath),
    pages_dropped_meta: String(reasons.dropped_meta),
    sections_dropped: String(sectionsDropped),
    paragraphs_dropped: String(paragraphsDropped),
    // Out-of-world sections, a separate cut from the era one above. The
    // breakdown is keyed by normalised heading, sorted so two builds from the
    // same dump write the same string.
    sections_trimmed: String(sectionsTrimmed),
    sections_trimmed_json: JSON.stringify(
      Object.fromEntries(
        Object.entries(sectionsTrimmedBy).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    ),
    redirects_dropped_dangling: String(redirectsDangling),
    bytes_read: String(bytes),
    build_ms: String(elapsedMs),
    schema_version: "5",
  });
  db.run("PRAGMA optimize");

  // The pre-swap gate: if the capitals and the starting zones are not in the
  // bundle, the era rules have eaten this world and the bundle must not be
  // renamed into place. Skipped for a `--max-pages` smoke build, which never
  // reaches most of the dump.
  if (args.canary) {
    try {
      assertCanaries(db);
    } catch (err) {
      db.close();
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }
  db.close();

  renameSync(tmpPath, args.out);
  const size = statSync(args.out).size;

  console.log("");
  console.log(`bundle:      ${args.out} (${fmtBytes(size)})`);
  console.log(`read:        ${fmtBytes(bytes)} of XML in ${fmtDuration(elapsedMs)}`);
  console.log(`page blocks: ${parseStats.blocksSeen + parseStats.pagesSkipped}`);
  console.log(`  dropped:   ${parseStats.pagesSkipped} (namespace)`);
  console.log(`pages seen:  ${pagesSeen} (blocks merged by title)`);
  console.log(`pages kept:  ${pagesKept} (${fmtBytes(charsKept)} of plain text)`);
  console.log(`era cutoff:  ${args.eraCutoff}`);
  console.log(`  swapped:   ${eraSwapped} (prose from an older revision)`);
  console.log(
    `  protected: ${preAnnouncementProtected} (post-Wrath signal, kept: the page predates the announcement)`,
  );
  console.log(`  late+wrath: ${reasons.post_cutoff_wrath_signal} (no pre-cutoff revision, explicit Wrath signal)`);
  console.log(`dropped:     ${reasons.dropped_post_cutoff} post-cutoff, ${reasons.dropped_post_wrath} post-Wrath, ${reasons.dropped_meta} out-of-game`);
  console.log(`  sections:  ${sectionsDropped}, paragraphs: ${paragraphsDropped}`);
  console.log(`trimmed:     ${sectionsTrimmed} out-of-world sections`);
  for (const [heading, n] of Object.entries(sectionsTrimmedBy)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)) {
    console.log(`  ${String(n).padStart(8)} ${heading}`);
  }
  console.log(`coord rows:  ${coordRows}`);
  console.log(`id rows:     ${idRows}`);
  console.log(`redirects:   ${redirects} (${redirectsDangling} dropped, target not in the bundle)`);
  console.log(`empty:       ${empties} rows with no prose (${emptiedByTrim} emptied by the trim)`);
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
