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
import { extractIds, type WikiId } from "./ids";
import { extractQuest } from "./quests";
import { admitPage, titleIsPostWrathCoinage, type AdmitReason } from "./post-wrath";
import { assertCanaries, MAX_REDIRECT_HOPS } from "./canary";
import { DEFAULT_ERA_CUTOFF, dropOutOfWorldOnly, dropPostWrath } from "./wrath-only";
import { DEFAULT_NAMESPACES, decodeUtf8, parsePages, type ParseStats, type WikiPage } from "./parse";
import { loadWorldIds } from "./world-ids";
import { redirectTarget, stripWikitext } from "./strip";

/**
 * How much of the signalled revision a stepped-back one has to be worth.
 *
 * The step-back below trades the newest pre-cutoff revision for an older, clean
 * one, and an older revision is sometimes a stub or a blanking. Measured over
 * the dump (2026-08-24): of 495 protected pages with an earlier signal-free
 * revision, 10 fall under this line — Varian Wrynn's was zero bytes — and the
 * other 485 keep 88% of the text at the median. A quarter is well clear of the
 * 0.17 the refused ones reach at p90 and well under the 0.5 the real step-backs
 * bottom out at, so nothing sits near the line.
 */
const STEP_BACK_MIN_RATIO = 0.25;

/**
 * Which revision a protected page's prose comes from.
 *
 * A page that predates the Cataclysm announcement is kept whatever a 2010
 * editor annotated it with (`isPreAnnouncementPage`), and until now it was
 * indexed from its newest pre-cutoff revision — which for Uldum, Gilneas,
 * Stormwind City and 482 others is the beta rewrite, not the page. The prose
 * is the newest pre-cutoff revision that carries **no** post-Wrath signal: the
 * page before the beta touched it. If there is none, or if stepping back would
 * trade an article for a stub, the signalled revision stays and is counted as a
 * refusal.
 */
export function eraSource(
  page: Pick<WikiPage, "eraWikitext" | "eraTimestamp" | "eraFreeWikitext" | "eraFreeTimestamp">,
  protectedPage: boolean,
): { text: string; timestamp: string; steppedBack: boolean; refused: boolean } {
  const era = { text: page.eraWikitext ?? "", timestamp: page.eraTimestamp };
  if (!protectedPage || page.eraFreeWikitext === null) {
    return { ...era, steppedBack: false, refused: false };
  }
  if (page.eraFreeTimestamp === page.eraTimestamp) {
    // The clean revision *is* the newest one: nothing stepped back.
    return { ...era, steppedBack: false, refused: false };
  }
  if (page.eraFreeWikitext.length < era.text.length * STEP_BACK_MIN_RATIO) {
    return { ...era, steppedBack: false, refused: true };
  }
  return {
    text: page.eraFreeWikitext,
    timestamp: page.eraFreeTimestamp,
    steppedBack: true,
    refused: false,
  };
}

/**
 * The parenthetical suffixes a page move leaves on the title that keeps this
 * world's article. In precedence order: a page with both `(original)` and
 * `(old)` siblings is answered by the first.
 */
const SIBLING_TITLE_SUFFIXES: readonly string[] = ["original", "old"];

/** A source title carrying one of them: `Deadmines (original)`. */
const SIBLING_SUFFIX = new RegExp(`^(.*\\S)\\s+\\((${SIBLING_TITLE_SUFFIXES.join("|")})\\)$`, "i");

/**
 * Names a page move left dangling: a bare title with no page and no redirect,
 * whose `(original)` or `(old)` sibling is in the bundle.
 *
 * MediaWiki carries a page's history to its destination when it is moved, so
 * after `Deadmines` was moved aside for the Cataclysm article the bare title
 * holds the *new* dungeon's revisions and is dropped, while everything this
 * world knows about the place sits under `Deadmines (original)`. The name a
 * character would search for is then in the bundle under a title nobody types.
 *
 * A candidate is generated, not a redirect: it goes into the same pending list
 * as every other and is resolved by the same bounded chain walk, so a sibling
 * that is itself only a redirect (`Stormwind Stockade (original)` →
 * `The Stockade (original)`) still lands, and one that leads nowhere is dropped
 * as dangling like any other.
 *
 * `resolvable` is every title that already answers — a kept page, or a redirect
 * whose chain actually landed — lower-cased. A redirect *source* is not enough:
 * a candidate that dangles answers nothing, and counting it here is what hid
 * this world's `Scarlet Monastery` behind a lower-cased spelling of the title
 * whose own redirect was never written. A bare title that already answers is
 * left alone. `(original)` wins over `(old)` when a page has both.
 */
export function siblingRedirects(
  survivors: readonly { title: string; ns: number }[],
  resolvable: ReadonlySet<string>,
): { source: string; target: string; ns: number }[] {
  const best = new Map<string, { source: string; target: string; ns: number; rank: number }>();
  for (const survivor of survivors) {
    const m = SIBLING_SUFFIX.exec(survivor.title);
    if (m === null) continue;
    const source = m[1]!;
    const key = source.toLowerCase();
    if (resolvable.has(key)) continue;
    const rank = SIBLING_TITLE_SUFFIXES.indexOf(m[2]!.toLowerCase());
    const prev = best.get(key);
    if (prev !== undefined && prev.rank <= rank) continue;
    best.set(key, { source, target: survivor.title, ns: survivor.ns, rank });
  }
  return [...best.values()].map(({ source, target, ns }) => ({ source, target, ns }));
}

const NS_NAMES: Record<number, string> = {
  0: "main",
  14: "Category",
  116: "Portal",
  118: "Quest",
};

/**
 * A metric's place in the page accounting identity. Every page the parser
 * yields is either a name (`pages_era_redirect`) or lands in exactly one
 * bucket, so the buckets sum to the total, and the `kept: true` buckets — the
 * rows actually in the bundle — sum to `pages_kept`. A subset is a tag on some
 * other counter's population and is deliberately outside both sums; `of` names
 * the counter it tags. `none` is a number with no place in the accounting at
 * all. The build test asserts both identities from this table, so a page
 * cannot be counted twice or lost quietly.
 */
type Identity =
  | { role: "none" }
  | { role: "total" }
  | { role: "bucket"; kept: boolean }
  | { role: "subset"; of: string };

export interface Metric {
  /** What the number means — the one place that is written down. */
  help: string;
  identity: Identity;
}

/**
 * Every number the build reports, stated once (it was three
 * hand-synced lists). The key is the bundle's `meta` key: `newCounters` zeroes
 * one counter per row for the build loop to increment, `metaCounters` writes
 * every row to `meta`, and `SUMMARY` below decides how each prints. Adding a
 * counter means adding a row — the meta write picks it up by itself, and the
 * `SummaryCoverage` check refuses to compile until the new row is either on a
 * summary line or deliberately listed in `UNPRINTED`.
 */
export const METRICS = {
  page_blocks_seen: {
    help:
      "`<page>` blocks in the dump, dropped namespaces included. A block is not a page: " +
      "a long history is several blocks of one page, so blocks seen exceeds pages seen.",
    identity: { role: "none" },
  },
  page_blocks_skipped_namespace: {
    help: "Blocks in namespaces the bundle does not carry.",
    identity: { role: "none" },
  },
  pages_in_namespaces: {
    help:
      "Pages the parser yielded: blocks merged by title, in the kept namespaces. " +
      "The accounting total every bucket sums to.",
    identity: { role: "total" },
  },
  pages_kept: {
    help: "Rows in the bundle. The sum of the `kept: true` buckets, empty rows included.",
    identity: { role: "none" },
  },
  chars_kept: {
    help: "Plain-text characters across every kept row.",
    identity: { role: "none" },
  },
  pages_distinct_keys: {
    help: "Distinct (title, ns) keys, asserted equal to the row count before the bundle lands.",
    identity: { role: "none" },
  },
  redirects: {
    help:
      "Redirect rows written after the stream: only chains that end at a page the bundle " +
      "has. Not a term of the identity — a redirect row can be generated for a title that " +
      "is also a counted page; `pages_era_redirect` is the term that carries the names.",
    identity: { role: "none" },
  },
  empty_pages: {
    help:
      "Rows with no prose: an infobox-only page, and a page the out-of-world trim " +
      "emptied. Rows, not drops — the title, the ids, the coords and the quest infobox " +
      "are still this world's — and counted here and nowhere else: the admitting buckets " +
      "are about pages with prose, and the identity would double-count an empty row.",
    identity: { role: "bucket", kept: true },
  },
  pages_emptied_by_trim: {
    help:
      "The subset of `empty_pages` that had prose before the out-of-world trim took it. " +
      "A page emptied by the ERA cuts is not here: it is dropped as post-Wrath.",
    identity: { role: "subset", of: "empty_pages" },
  },
  coord_rows: {
    help: "Coordinates extracted from the newest revisions of kept pages.",
    identity: { role: "none" },
  },
  id_rows: {
    help: "Ids extracted from the newest revisions of kept pages.",
    identity: { role: "none" },
  },
  quest_rows: {
    help: "Kept pages with a quest infobox.",
    identity: { role: "none" },
  },
  pages_era_swapped: {
    help: "Kept pages whose prose came from an older revision than the structured fields did.",
    identity: { role: "subset", of: "pages_pre_cutoff" },
  },
  pages_pre_announcement_protected: {
    help:
      "Kept pages that carried a post-Wrath signal and were kept anyway, because they " +
      "predate the Cataclysm announcement (`CATACLYSM_ANNOUNCED`).",
    identity: { role: "subset", of: "pages_pre_cutoff" },
  },
  pages_stepped_back: {
    help:
      "Protected pages whose prose came from an earlier, signal-free revision instead " +
      "of the newest pre-cutoff one (`eraSource`).",
    identity: { role: "subset", of: "pages_pre_cutoff" },
  },
  pages_step_back_refused: {
    help: "Protected pages where that step back was refused because the earlier revision was a stub.",
    identity: { role: "subset", of: "pages_pre_cutoff" },
  },
  pages_pre_cutoff: {
    help: "Admitted on a surviving pre-cutoff revision (`admitPage`), which is where its prose comes from.",
    identity: { role: "bucket", kept: true },
  },
  pages_post_cutoff_wrath_signal: {
    help: "Admitted with no pre-cutoff revision, on an explicit Wrath signal in the newest one.",
    identity: { role: "bucket", kept: true },
  },
  pages_post_cutoff_id_match: {
    help:
      "Admitted with no pre-cutoff revision, because an id the page states about itself " +
      "exists on this server under an agreeing name.",
    identity: { role: "bucket", kept: true },
  },
  pages_id_name_mismatch: {
    help:
      "Late pages that stated an id this server has, under a name that is not what the " +
      "page is about, and were dropped for it. The population the name rule exists for, " +
      "and the number to watch if the rule is ever loosened or tightened.",
    identity: { role: "subset", of: "pages_dropped_post_cutoff" },
  },
  pages_dropped_post_cutoff: {
    help: "Dropped: no usable pre-cutoff prose, and neither the Wrath-signal nor the id door admitted it.",
    identity: { role: "bucket", kept: false },
  },
  pages_dropped_post_wrath: {
    help:
      "Dropped as another world's page: `admitPage` said so, or the era cuts emptied " +
      "everything the out-of-world trim would have kept.",
    identity: { role: "bucket", kept: false },
  },
  pages_dropped_meta: {
    help: "Dropped as out-of-game: a patch archive, the addon API, a real-world topic.",
    identity: { role: "bucket", kept: false },
  },
  sections_dropped: {
    help: "Post-Wrath sections cut inside kept pages, before the strip.",
    identity: { role: "none" },
  },
  paragraphs_dropped: {
    help: "Post-Wrath paragraphs cut inside kept pages, before the strip.",
    identity: { role: "none" },
  },
  sections_trimmed: {
    help:
      "Out-of-world sections cut inside surviving pages — a separate cut from the era " +
      "one. The sum of `sections_trimmed_json`'s breakdown; nothing counts it twice.",
    identity: { role: "none" },
  },
  redirects_dropped_dangling: {
    help: "Redirect candidates whose chain ends at no page this bundle has.",
    identity: { role: "none" },
  },
  pages_era_redirect: {
    help:
      "Pages whose Wrath-snapshot revision was a `#REDIRECT`. Names, not pages: the " +
      "term that takes the redirects out of the reason identity.",
    identity: { role: "bucket", kept: false },
  },
  redirects_recovered_newest: {
    help:
      "Redirect rows that exist only because the newest revision was read after the " +
      "Wrath-snapshot one dangled, or because the page itself is gone and its newest " +
      "revision says where the name went.",
    identity: { role: "subset", of: "redirects" },
  },
  redirects_original_sibling: {
    help: "Redirect rows generated from an `(original)`/`(old)` sibling: the bare title a page move emptied.",
    identity: { role: "subset", of: "redirects" },
  },
  bytes_read: {
    help: "XML bytes read off the dump stream.",
    identity: { role: "none" },
  },
  build_ms: {
    help: "Wall-clock build time.",
    identity: { role: "none" },
  },
} satisfies Record<string, Metric>;

export type MetricKey = keyof typeof METRICS;
export type Counters = Record<MetricKey, number>;

function newCounters(): Counters {
  return Object.fromEntries(Object.keys(METRICS).map((key) => [key, 0])) as Counters;
}

/** Every metric, stringified for the bundle's `meta` table. */
function metaCounters(n: Counters): Record<MetricKey, string> {
  return Object.fromEntries(
    (Object.keys(METRICS) as MetricKey[]).map((key) => [key, String(n[key])]),
  ) as Record<MetricKey, string>;
}

/**
 * The counter an `admitPage` reason increments. The return type is the index
 * into `Counters`, so a reason with no row in `METRICS` fails to compile.
 */
const reasonKey = (reason: AdmitReason): `pages_${AdmitReason}` => `pages_${reason}`;

/** What a summary line needs beyond the counters themselves. */
interface SummaryCtx {
  out: string;
  size: number;
  eraCutoff: string;
  sectionsTrimmedBy: Readonly<Record<string, number>>;
  perNamespace: Readonly<Record<number, number>>;
}

interface SummaryLine {
  /** Every metric this line prints; the coverage check below reads it. */
  uses: readonly MetricKey[];
  render: (n: Counters, ctx: SummaryCtx) => string | readonly string[];
}

/** The console summary, in print order. */
const SUMMARY = [
  { uses: [], render: (_n, ctx) => `bundle:      ${ctx.out} (${fmtBytes(ctx.size)})` },
  {
    uses: ["bytes_read", "build_ms"],
    render: (n) => `read:        ${fmtBytes(n.bytes_read)} of XML in ${fmtDuration(n.build_ms)}`,
  },
  { uses: ["page_blocks_seen"], render: (n) => `page blocks: ${n.page_blocks_seen}` },
  {
    uses: ["page_blocks_skipped_namespace"],
    render: (n) => `  dropped:   ${n.page_blocks_skipped_namespace} (namespace)`,
  },
  {
    uses: ["pages_in_namespaces"],
    render: (n) => `pages seen:  ${n.pages_in_namespaces} (blocks merged by title)`,
  },
  {
    uses: ["pages_kept", "chars_kept"],
    render: (n) => `pages kept:  ${n.pages_kept} (${fmtBytes(n.chars_kept)} of plain text)`,
  },
  { uses: [], render: (_n, ctx) => `era cutoff:  ${ctx.eraCutoff}` },
  {
    uses: ["pages_era_swapped"],
    render: (n) => `  swapped:   ${n.pages_era_swapped} (prose from an older revision)`,
  },
  {
    uses: ["pages_pre_announcement_protected"],
    render: (n) =>
      `  protected: ${n.pages_pre_announcement_protected} (post-Wrath signal, kept: the page predates the announcement)`,
  },
  {
    uses: ["pages_stepped_back", "pages_step_back_refused"],
    render: (n) =>
      `  stepped back: ${n.pages_stepped_back} (prose from the last signal-free revision), ` +
      `${n.pages_step_back_refused} refused (that revision was a stub)`,
  },
  {
    uses: ["pages_post_cutoff_wrath_signal"],
    render: (n) =>
      `  late+wrath: ${n.pages_post_cutoff_wrath_signal} (no pre-cutoff revision, explicit Wrath signal)`,
  },
  {
    uses: ["pages_post_cutoff_id_match", "pages_id_name_mismatch"],
    render: (n) =>
      `  late+id:   ${n.pages_post_cutoff_id_match} (no pre-cutoff revision, states an id this ` +
      `server has under this name; ${n.pages_id_name_mismatch} dropped, the id is something else here)`,
  },
  {
    uses: ["pages_dropped_post_cutoff", "pages_dropped_post_wrath", "pages_dropped_meta"],
    render: (n) =>
      `dropped:     ${n.pages_dropped_post_cutoff} post-cutoff, ${n.pages_dropped_post_wrath} post-Wrath, ${n.pages_dropped_meta} out-of-game`,
  },
  {
    uses: ["sections_dropped", "paragraphs_dropped"],
    render: (n) => `  sections:  ${n.sections_dropped}, paragraphs: ${n.paragraphs_dropped}`,
  },
  {
    uses: ["sections_trimmed"],
    render: (n, ctx) => [
      `trimmed:     ${n.sections_trimmed} out-of-world sections`,
      ...Object.entries(ctx.sectionsTrimmedBy)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([heading, count]) => `  ${String(count).padStart(8)} ${heading}`),
    ],
  },
  { uses: ["coord_rows"], render: (n) => `coord rows:  ${n.coord_rows}` },
  { uses: ["id_rows"], render: (n) => `id rows:     ${n.id_rows}` },
  {
    uses: ["redirects", "redirects_dropped_dangling"],
    render: (n) =>
      `redirects:   ${n.redirects} (${n.redirects_dropped_dangling} dropped, target not in the bundle)`,
  },
  {
    uses: ["redirects_recovered_newest", "redirects_original_sibling"],
    render: (n) =>
      `  recovered: ${n.redirects_recovered_newest} via the newest revision, ` +
      `${n.redirects_original_sibling} via an (original) sibling`,
  },
  {
    uses: ["empty_pages", "pages_emptied_by_trim"],
    render: (n) =>
      `empty:       ${n.empty_pages} rows with no prose (${n.pages_emptied_by_trim} emptied by the trim)`,
  },
  {
    uses: [],
    render: (_n, ctx) =>
      Object.keys(ctx.perNamespace)
        .map(Number)
        .sort((a, b) => a - b)
        .map((ns) => `  ns ${String(ns).padStart(3)} ${(NS_NAMES[ns] ?? "?").padEnd(9)} ${ctx.perNamespace[ns]}`),
  },
] as const satisfies readonly SummaryLine[];

/** Metrics deliberately absent from the summary, each with its reason. */
const UNPRINTED = [
  "quest_rows", // in meta; the summary has never printed it
  "pages_distinct_keys", // an invariant (`assertUniquePages`), not a result
  "pages_pre_cutoff", // the era-cutoff block prints its tags; "pages kept" carries the bulk
  "pages_era_redirect", // the redirects lines tell the names story
] as const satisfies readonly MetricKey[];

/**
 * Compile-time coverage: instantiating `AssertEmpty` with a non-`never` type
 * is an error, so a metric that is neither on a summary line's `uses` nor in
 * `UNPRINTED` names itself in a type error here.
 */
type Printed = (typeof SUMMARY)[number]["uses"][number] | (typeof UNPRINTED)[number];
type AssertEmpty<T extends never> = T;
export type SummaryCoverage = AssertEmpty<Exclude<MetricKey, Printed>>;

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
  /**
   * Path to a world-id export (`infra/export-world-ids.sh`), or "" for none.
   * Absent, the build behaves exactly as it did before the id door existed and
   * `meta.world_ids` records the absence; present, a late page whose stated id
   * exists on this server is admitted as `post_cutoff_id_match`.
   */
  worldIds: string;
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
  let worldIds = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") out = argv[++i] ?? out;
    else if (arg === "--max-pages") maxPages = Number.parseInt(argv[++i] ?? "0", 10);
    else if (arg === "--era-cutoff") eraCutoff = argv[++i] ?? eraCutoff;
    else if (arg === "--world-ids") worldIds = argv[++i] ?? worldIds;
    else if (arg === "--no-canary") canary = false;
    else if (arg === "--canary") canary = true;
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
    else dump = arg;
  }
  if (dump === "") {
    throw new Error(
      "usage: bun wiki/src/build.ts <dump.7z|dump.xml> [--out path] [--max-pages n] " +
        "[--era-cutoff YYYY-MM-DDTHH:MM:SSZ] [--world-ids path] [--no-canary]",
    );
  }
  if (!ISO_INSTANT.test(eraCutoff)) {
    throw new Error(
      `--era-cutoff must be a full ISO-8601 UTC instant like ${DEFAULT_ERA_CUTOFF}, got ${eraCutoff}`,
    );
  }
  return {
    dump,
    out,
    maxPages,
    eraCutoff,
    canary: canary ?? !Number.isFinite(maxPages),
    worldIds,
  };
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

  // Same reason: a malformed world-id export stops the build here rather than
  // producing a bundle that quietly ignored the flag it was given.
  const worldIds = args.worldIds === "" ? undefined : await loadWorldIds(args.worldIds);
  if (worldIds !== undefined) {
    console.log(
      `world ids:   ${args.worldIds} (exported ${worldIds.exportedAt || "?"}, ` +
        `${Object.entries(worldIds.counts)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")})`,
    );
  }

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

  // Every counter is a `METRICS` row; what each number means lives there.
  const n = newCounters();
  const perNamespace: Record<number, number> = {};
  /** Out-of-world sections cut inside a surviving page, by heading. */
  const sectionsTrimmedBy: Record<string, number> = {};
  /**
   * Redirects are written after the stream, not during: a redirect whose target
   * did not survive the Wrath cutoff points at nothing, and whether the target
   * survived is not known until every page has been seen. With `--max-pages`
   * the stream stops early, so a smoke build drops every redirect whose target
   * it never reached; its `redirects` count is not comparable to a full build's.
   */
  const pendingRedirects: {
    source: string;
    target: string;
    ns: number;
    /**
     * Where the candidate came from: the Wrath-snapshot revision, the newest
     * revision of a page this bundle has no article for, or the `(original)`
     * sibling of a moved page. Only the counters read it.
     */
    origin: "era" | "newest" | "sibling";
    /**
     * The newest revision's target, when the era revision named a different one.
     * A page move renames the target out from under a 2010 redirect, and the
     * newest revision is where the wiki says where the name went.
     */
    fallback?: string;
  }[] = [];
  const keptTitles = new Set<string>();
  let stoppedEarly = false;
  const parseStats: ParseStats = { pagesSkipped: 0, blocksSeen: 0 };

  const started = Date.now();
  let lastLog = started;
  const logProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLog < 15_000) return;
    lastLog = now;
    const elapsed = (now - started) / 1000;
    const rate = n.bytes_read / 1024 ** 2 / Math.max(elapsed, 0.001);
    console.log(
      `[${fmtDuration(now - started)}] ${fmtBytes(n.bytes_read)} read (${rate.toFixed(0)} MiB/s), ` +
        `${parseStats.blocksSeen + parseStats.pagesSkipped} page blocks seen ` +
        `(${parseStats.pagesSkipped} in dropped namespaces), ${n.pages_kept} kept, ` +
        `${n.redirects} redirects`,
    );
  };

  const { bytes: stream, done, cancel } = openDump(args.dump);
  const chunks = decodeUtf8(stream, (total) => {
    n.bytes_read = total;
  });

  /**
   * A page this bundle has no article for, whose newest revision is a redirect:
   * keep the *name*.
   *
   * A page move carries the history to the destination, so a title the wiki
   * later redirected away has its whole 2010 history sitting under the new name
   * and reads as post-cutoff here. The page is correctly absent; the name is
   * not, and the newest revision is the only place the wiki says where it went.
   * The candidate is resolved with all the others, so it lands only if the
   * chain ends at a page this bundle actually has.
   *
   * Out-of-game titles are the exception and stay out entirely. The build drops
   * a patch archive or an addon-API page rather than demoting it, and a name
   * that resolves is a name search can return; `verify.ts` checks exactly that
   * for the patch pages.
   */
  const keepAsName = (page: WikiPage, reason: AdmitReason): void => {
    if (reason === "dropped_meta") return;
    if (titleIsPostWrathCoinage(page.ns, page.title)) return;
    const target = redirectTarget(page.wikitext);
    if (target === null) return;
    pendingRedirects.push({ source: page.title, target, ns: page.ns, origin: "newest" });
  };

  /**
   * Write one admitted page. `source` is the revision its prose comes from —
   * the pre-cutoff one, or the newest for a page admitted on an explicit Wrath
   * signal. Structured fields always come off the newest revision, where a
   * decade of corrections lives and where 30% of the coordinates only exist.
   */
  const keep = (
    page: WikiPage,
    source: string,
    reason: AdmitReason,
    opts: {
      protectedPage?: boolean;
      sourceTimestamp?: string;
      /** The ids the admission already extracted from this same wikitext. */
      ids?: WikiId[];
    } = {},
  ): boolean => {
    const protectedPage = opts.protectedPage ?? false;
    const sourceTimestamp = opts.sourceTimestamp ?? page.timestamp;
    // Coords and ids come off the RAW wikitext before the strip destroys the
    // templates that carry them.
    const coords = extractCoords(page.wikitext);
    const ids = opts.ids ?? extractIds(page.wikitext);
    const quest = extractQuest(page.wikitext);
    // Post-Wrath sections and paragraphs go before the strip, which would
    // otherwise remove the templates and headings that identify them.
    const cut = dropPostWrath(source);
    n.sections_dropped += cut.sectionsDropped;
    n.paragraphs_dropped += cut.paragraphsDropped;
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
      // Dropped, and the caller counts it: the reasons are its ledger.
      if (trimmedOnly.length > 0) return false;
      const hadProse = stripWikitext(source).length > 0;
      emptied = true;
      n.empty_pages++;
      if (hadProse) n.pages_emptied_by_trim++;
    }
    writer.addPage(page.title, page.ns, text, coords, ids, quest);
    if (!emptied) {
      n[reasonKey(reason)]++;
      // Counted here rather than at decision time: a protected page can still be
      // emptied by the cuts above, and the counter is a subset of `pre_cutoff`.
      if (protectedPage) n.pages_pre_announcement_protected++;
      // Only meaningful for a pre-cutoff admission: a page admitted on a Wrath
      // signal has one revision to read, so its prose is never "swapped".
      if (reason === "pre_cutoff" && sourceTimestamp !== page.timestamp) n.pages_era_swapped++;
    }
    keptTitles.add(page.title.toLowerCase());
    n.pages_kept++;
    n.chars_kept += text.length;
    n.coord_rows += coords.length;
    n.id_rows += ids.length;
    if (quest !== null) n.quest_rows++;
    perNamespace[page.ns] = (perNamespace[page.ns] ?? 0) + 1;
    return true;
  };

  console.log(`building ${args.out} from ${args.dump}`);
  try {
    for await (const page of parsePages(chunks, DEFAULT_NAMESPACES, parseStats, args.eraCutoff)) {
      n.pages_in_namespaces++;
      // Redirect-ness is decided by the Wrath snapshot: the newest pre-cutoff
      // revision. A page that redirects today but was an article in 2010 is an
      // article here, and one that was a redirect then stays one whatever it
      // became later. A page with no pre-cutoff revision at all is not in this
      // world's wiki, redirect or not.
      const target = page.eraRedirectTarget;
      if (target !== null) {
        n.pages_era_redirect++;
        const newest = redirectTarget(page.wikitext);
        // A later expansion's own coinage is not a name this world answers to,
        // whatever the wiki later pointed it at (`Ruins of Gilneas` → `Gilneas`
        // is the shape).
        if (!titleIsPostWrathCoinage(page.ns, page.title)) {
          pendingRedirects.push({
            source: page.title,
            target,
            ns: page.ns,
            origin: "era",
            ...(newest !== null && newest !== target ? { fallback: newest } : {}),
          });
        }
      } else {
        // One door, one call. `eraWikitext` is null unless a pre-cutoff
        // revision survived the parser's hygiene rules, and `hasEraRevision`
        // says whether there was one at all — the two together are how
        // `admitPage` tells "this world's wiki has no such page" from "this
        // page has no prose to index".
        //
        // The oracle is handed over only for a page with no pre-cutoff revision
        // at all, which is the case the id door exists for: an id cannot supply
        // prose a page never had.
        const decision = admitPage({
          title: page.title,
          ns: page.ns,
          eraWikitext: page.eraWikitext,
          hasEraRevision: page.hasEraRevision,
          newestWikitext: page.wikitext,
          firstRevisionAt: page.firstRevisionAt,
          ...(!page.hasEraRevision && worldIds !== undefined ? { worldIds } : {}),
        });
        if (!decision.admit) {
          n[reasonKey(decision.reason)]++;
          if (decision.idNameMismatch === true) n.pages_id_name_mismatch++;
          // A page dropped for having no usable pre-cutoff prose is not a name
          // a page move left behind, which is what the recovery below is for.
          if (decision.eraRevisionsRejected !== true) keepAsName(page, decision.reason);
        } else if (decision.reason === "pre_cutoff") {
          // The only admitting reason with two revisions to choose between.
          const protectedPage = decision.preAnnouncementProtected === true;
          const src = eraSource(page, protectedPage);
          if (src.steppedBack) n.pages_stepped_back++;
          if (src.refused) n.pages_step_back_refused++;
          const kept = keep(page, src.text, decision.reason, {
            protectedPage,
            sourceTimestamp: src.timestamp,
          });
          if (!kept) n.pages_dropped_post_wrath++;
        } else if (!keep(page, page.wikitext, decision.reason, { ids: decision.ids })) {
          // Admitted late, on an explicit Wrath signal or on an id: the newest
          // revision is the only one there is.
          n.pages_dropped_post_wrath++;
        }
      }
      logProgress();
      if (n.pages_in_namespaces >= args.maxPages) {
        stoppedEarly = true;
        break;
      }
    }
    // The pages are all in by now. Redirects are resolved in two passes, and
    // the order is the fix for a name that used to go missing: whether a
    // candidate *answers* its title is not known until its chain has been
    // walked, so the sibling rule cannot run until every other candidate has
    // been resolved. `Scarlet Monastery` was the case that showed it — a
    // lower-cased spelling of the title redirected to it, that redirect
    // dangled, and the bare title counted as answered on the strength of a row
    // that was never written, so the sibling rule left it alone and this
    // world's article sat in the bundle under a title nobody types.
    //
    // The sibling rule also reads the pages back out of the half-built bundle
    // rather than keeping a second copy of every title in memory. `flush` is
    // idempotent, so the one at the end of the block still stands.
    writer.flush();
    type Pending = (typeof pendingRedirects)[number];

    // A chain is walked with the same bound `resolveTitle` uses, so a redirect
    // to a redirect to a page still lands; one that ends at a dropped page is
    // dropped with it.
    const targets = new Map<string, string>();
    for (const r of pendingRedirects) targets.set(r.source.toLowerCase(), r.target);
    const walk = (from: string): boolean => {
      let current = from.toLowerCase();
      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        if (keptTitles.has(current)) return true;
        const next = targets.get(current);
        if (next === undefined) return false;
        current = next.toLowerCase();
      }
      return false;
    };
    /**
     * The target that lands, or null when the chain leads nowhere. Whichever
     * target lands is the one written: the row is walked again at query time,
     * so a row pointing at a title with no page and no redirect of its own is a
     * dead row.
     */
    const resolveCandidate = (r: Pending): { landed: string; viaNewest: boolean } | null => {
      if (walk(r.target)) return { landed: r.target, viaNewest: r.origin === "newest" };
      if (r.fallback !== undefined && walk(r.fallback)) {
        return { landed: r.fallback, viaNewest: true };
      }
      return null;
    };
    /** Exact source strings a row has been written for; the counters key on it. */
    const written = new Set<string>();
    const write = (r: Pending, res: { landed: string; viaNewest: boolean }): void => {
      writer.addRedirect(r.source, res.landed, r.ns);
      written.add(r.source);
      n.redirects++;
      if (res.viaNewest) n.redirects_recovered_newest++;
      else if (r.origin === "sibling") n.redirects_original_sibling++;
    };

    // Pass one: every candidate the stream produced. One that leads nowhere is
    // held back rather than dropped — the sibling rule may yet put a page at
    // the end of its chain.
    const unresolved: Pending[] = [];
    const answered = new Set(keptTitles);
    for (const r of pendingRedirects) {
      const res = resolveCandidate(r);
      if (res === null) {
        unresolved.push(r);
        continue;
      }
      write(r, res);
      answered.add(r.source.toLowerCase());
    }

    // Pass two: the sibling rule, over the titles that are still unanswered.
    // `answered` is a kept page or a redirect that actually landed, never one
    // that dangled.
    const survivors: { title: string; ns: number }[] = db
      .query<{ title: string; ns: number }, string[]>(
        `SELECT title, ns FROM pages WHERE ${SIBLING_TITLE_SUFFIXES.map(() => "title LIKE ?").join(" OR ")}`,
      )
      .all(...SIBLING_TITLE_SUFFIXES.map((suffix) => `% (${suffix})`));
    // A sibling that is itself only a redirect counts: `Stormwind Stockade
    // (original)` is one, and the chain through it is what reaches the page.
    // Only the ones that landed, so a sibling never points into a dead row.
    for (const r of pendingRedirects) {
      if (written.has(r.source)) survivors.push({ title: r.source, ns: r.ns });
    }
    // A later expansion's own coinage is not a name this world answers to,
    // whatever the wiki later pointed it at (`Ruins of Gilneas` -> `Gilneas`
    // is the shape).
    const siblings: Pending[] = siblingRedirects(survivors, answered)
      .filter((s) => !titleIsPostWrathCoinage(s.ns, s.source))
      .map((s) => ({
        ...s,
        origin: "sibling" as const,
      }));
    // Overwriting the pending target for this key is load-bearing, not an
    // oversight to tidy away: the key is unanswered precisely because whatever
    // stood there dangled, and replacing it is what lets the rows that pointed
    // at the bare title — an alternate spelling, an older name — land through
    // the sibling when they are retried below.
    for (const s of siblings) targets.set(s.source.toLowerCase(), s.target);
    pendingRedirects.push(...siblings);

    // The new candidates, and the retry of the held-back ones. A held-back row
    // whose own title the sibling rule just claimed stays dangling: its
    // candidate still leads nowhere, and the row that answers for that title is
    // the sibling's.
    for (const r of [...siblings, ...unresolved]) {
      const res = written.has(r.source) ? null : resolveCandidate(r);
      if (res === null) {
        n.redirects_dropped_dangling++;
        continue;
      }
      write(r, res);
    }
    writer.flush();
    if (stoppedEarly) cancel();
    else await done();
    n.pages_distinct_keys = assertUniquePages(db);
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

  n.build_ms = Date.now() - started;
  n.page_blocks_seen = parseStats.blocksSeen + parseStats.pagesSkipped;
  n.page_blocks_skipped_namespace = parseStats.pagesSkipped;
  // The trim total is the breakdown's sum; nothing counts it a second time.
  n.sections_trimmed = Object.values(sectionsTrimmedBy).reduce((a, b) => a + b, 0);
  setMeta(db, {
    source: basename(args.dump),
    built_at: new Date().toISOString(),
    namespaces: [...DEFAULT_NAMESPACES].join(","),
    era_cutoff: args.eraCutoff,
    // Which world-id export the id door read, if any. Recorded so a bundle
    // built against a different export is visible on the comparability tuple:
    // the door's answer is a function of this file.
    world_ids:
      worldIds === undefined
        ? "none"
        : JSON.stringify({
            source: basename(args.worldIds),
            exported_at: worldIds.exportedAt,
            counts: worldIds.counts,
          }),
    // The out-of-world trim broken down by normalised heading, sorted so two
    // builds from the same dump write the same string. `sections_trimmed` in
    // the counters below is this breakdown's sum.
    sections_trimmed_json: JSON.stringify(
      Object.fromEntries(
        Object.entries(sectionsTrimmedBy).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    ),
    schema_version: "5",
    // Every `METRICS` row; what each number means is documented there.
    ...metaCounters(n),
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

  const ctx: SummaryCtx = {
    out: args.out,
    size,
    eraCutoff: args.eraCutoff,
    sectionsTrimmedBy,
    perNamespace,
  };
  console.log("");
  for (const line of SUMMARY) {
    const rendered = line.render(n, ctx);
    for (const text of typeof rendered === "string" ? [rendered] : rendered) console.log(text);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
