/**
 * Streaming MediaWiki XML export parser.
 *
 * The dump is 24 GB of export-0.10 full history, so this never materialises a
 * document or a page's history, and holds only the few revision bodies that can
 * still win a slot:
 *
 * - Pages outside the wanted namespaces are skipped with a single indexOf to
 *   `</page>`; nothing in them is decoded. That is most of a history dump.
 * - Within a page, `<id>` and `<timestamp>` precede `<text>`, so whether a
 *   revision can win either slot is known before its body arrives. A revision
 *   that cannot win is skipped without being buffered or decoded. Peak memory
 *   is the newest body plus at most two era candidates (below), whatever the
 *   history depth.
 * - Two slots per page. `wikitext` is the newest revision, which is what the
 *   structured extractors (coords, ids, quest infobox) read. `eraWikitext` is
 *   the newest revision saved before the era cutoff, which is what the prose
 *   index reads: the dump is from 2020 and this world is patch 3.3.5a
 *   (ADR-0040). A page with no pre-cutoff revision has `eraWikitext` null and
 *   the build labels it.
 * - Selection is by (timestamp, revision id), so it does not depend on the
 *   dump's revision ordering. This dump happens to be newest-first; others are
 *   oldest-first.
 * - Era-slot hygiene. A candidate whose text is a `#REDIRECT` is never a
 *   winner: the page is an article now, and a revision where it was a redirect
 *   is not prose. A candidate that was immediately reverted is skipped too —
 *   the revision right after it restored a sha1 the page already had, so its
 *   edit was undone. That test needs both a newer and an older revision, and
 *   `<sha1>` is emitted *after* `<text>`, so no single-pass detector can decide
 *   it at capture time in either arrival order. It is therefore decided at page
 *   finish, over a per-page ledger of (timestamp, id, sha1) — metadata, not
 *   bodies — and the two newest pre-cutoff non-redirect bodies are held so the
 *   runner-up is available when the newest one is rejected. Two consecutive
 *   reverted revisions is past what the window sees; the page then keeps the
 *   older of the two rather than losing its prose.
 * - A page with more than 50 revisions is exported as several consecutive
 *   `<page>` blocks carrying the same title and ns, 50 revisions each. A block
 *   is therefore not a page: the accumulator is held pending and finished only
 *   when the (title, ns) key changes or the stream ends, so a split page still
 *   yields one WikiPage holding its genuinely newest revision. Blocks for a
 *   page are contiguous in the dump; a stray later block would yield a second
 *   page, which the build's uniqueness check catches.
 *
 * The buffer is compacted once per input chunk and every scan starts at the
 * cursor, so there is no quadratic re-scan of accumulated text.
 *
 * Bun has no streaming XML parser and this is a fixed, known-shape document, so
 * a hand-rolled state machine beats taking a dependency.
 */

import { decodeEntities } from "./entities";
import { DEFAULT_ERA_CUTOFF } from "./era";
import { redirectTarget } from "./strip";

export interface WikiPage {
  title: string;
  ns: number;
  /** Raw wikitext of the newest revision. */
  wikitext: string;
  /** Revision timestamp of the newest revision, ISO 8601, or "" if absent. */
  timestamp: string;
  /**
   * Raw wikitext of the newest revision saved before the era cutoff that passed
   * the hygiene rules, or null when the page has none. The prose index reads
   * this; the structured extractors read `wikitext`.
   */
  eraWikitext: string | null;
  /** Timestamp of that revision, or "" when there is none. */
  eraTimestamp: string;
  /** Target of a `<redirect title="..."/>` element, when the dump emits one. */
  redirectAttr: string | null;
}

/**
 * Counters the caller can read after (or during) a parse. Both count `<page>`
 * *blocks*, not pages: a long history arrives as several blocks of the same
 * page (see the header), and only the yielded WikiPages are pages.
 */
export interface ParseStats {
  /** Blocks dropped because their namespace is not wanted. */
  pagesSkipped: number;
  /** Blocks in a wanted namespace, before merging. */
  blocksSeen: number;
}

/** Namespaces worth keeping for an agent playing the game. */
export const DEFAULT_NAMESPACES: ReadonlySet<number> = new Set([
  0, // main
  14, // Category
  116, // Portal
  118, // Quest
]);

const enum State {
  OutsidePage,
  InPage,
  InRevision,
  Capturing,
  SkippingPage,
}

/** One revision's identity, kept for the whole page. No body, no title. */
interface RevMeta {
  ts: string;
  id: number;
  sha1: string;
}

/** A pre-cutoff revision still in the running for the era slot, with its body. */
interface EraCandidate {
  ts: string;
  id: number;
  text: string;
}

interface PageAccum {
  title: string;
  ns: number;
  redirectAttr: string | null;
  bestTimestamp: string;
  bestRevId: number;
  bestText: string | null;
  /** The two newest pre-cutoff non-redirect revisions, newest first. */
  eraCands: EraCandidate[];
  /** Every revision seen, for the revert test at page finish. */
  revs: RevMeta[];
}

function tagNameOf(tag: string): string {
  let i = 1;
  if (tag.charCodeAt(1) === 0x2f /* / */) i = 2;
  let j = i;
  while (j < tag.length) {
    const c = tag.charCodeAt(j);
    if (c === 0x20 || c === 0x2f || c === 0x3e || c === 0x09 || c === 0x0a) break;
    j++;
  }
  return tag.slice(i, j);
}

function attrOf(tag: string, name: string): string | null {
  const key = ` ${name}="`;
  const at = tag.indexOf(key);
  if (at === -1) return null;
  const start = at + key.length;
  const end = tag.indexOf('"', start);
  if (end === -1) return null;
  return decodeEntities(tag.slice(start, end));
}

/** True if the newer (ts, id) beats the incumbent. */
function beats(ts: string, id: number, bestTs: string, bestId: number): boolean {
  if (ts > bestTs) return true;
  if (ts < bestTs) return false;
  return id > bestId;
}

/** How many pre-cutoff bodies are held at once (see the header). */
const ERA_WINDOW = 2;

/** True if (ts, id) would enter the era candidate window as it stands. */
function eraWants(cands: readonly EraCandidate[], ts: string, id: number): boolean {
  if (cands.length < ERA_WINDOW) return true;
  const last = cands[cands.length - 1]!;
  return beats(ts, id, last.ts, last.id);
}

/** Insert newest-first and drop anything past the window. */
function eraOffer(cands: EraCandidate[], cand: EraCandidate): void {
  let i = 0;
  while (i < cands.length && !beats(cand.ts, cand.id, cands[i]!.ts, cands[i]!.id)) i++;
  cands.splice(i, 0, cand);
  if (cands.length > ERA_WINDOW) cands.length = ERA_WINDOW;
}

/**
 * True when the revision right after `cand` restored a sha1 the page already
 * had before `cand`: `cand`'s edit was undone, so it is not what the page said.
 * Cheap because it walks metadata only, and runs at most twice per page.
 */
function wasReverted(revs: readonly RevMeta[], cand: EraCandidate): boolean {
  let next: RevMeta | undefined;
  for (const r of revs) {
    if (!beats(r.ts, r.id, cand.ts, cand.id)) continue; // not newer than cand
    if (next === undefined || beats(next.ts, next.id, r.ts, r.id)) next = r;
  }
  if (next === undefined || next.sha1 === "") return false;
  for (const r of revs) {
    if (r.id === cand.id && r.ts === cand.ts) continue;
    if (beats(r.ts, r.id, cand.ts, cand.id)) continue; // not older than cand
    if (r.sha1 !== "" && r.sha1 === next.sha1) return true;
  }
  return false;
}

/** The newest candidate in the window that survives the hygiene rules. */
function eraWinner(p: PageAccum): EraCandidate | null {
  for (const cand of p.eraCands) {
    if (!wasReverted(p.revs, cand)) return cand;
  }
  return null;
}

/**
 * Parse a stream of decoded XML text into pages, newest revision per page.
 *
 * `chunks` may split anywhere, including mid-tag and mid-entity is not
 * supported (the caller must decode UTF-8 with a streaming decoder, which keeps
 * entities intact since they are ASCII and never split by the decoder).
 */
export async function* parsePages(
  chunks: AsyncIterable<string>,
  namespaces: ReadonlySet<number> = DEFAULT_NAMESPACES,
  stats?: ParseStats,
  eraCutoff: string = DEFAULT_ERA_CUTOFF,
): AsyncGenerator<WikiPage, void, undefined> {
  let buf = "";
  let pos = 0;
  let state: State = State.OutsidePage;
  let resume: State = State.OutsidePage;

  // Held in an object so the closure below can set them without the compiler
  // narrowing them to their initial values.
  const cap: {
    end: string;
    field: string;
    /** null = discard the captured bytes rather than build a string. */
    parts: string[] | null;
    keep: boolean;
  } = { end: "", field: "", parts: null, keep: false };

  let page: PageAccum | null = null;
  /**
   * The last block's accumulator, awaiting a key change (see the header). In an
   * object for the same reason `cap` is: the compiler otherwise narrows a `let`
   * to its initialiser here.
   */
  const held: { pending: PageAccum | null } = { pending: null };
  let revId = -1;
  let revTs = "";
  let revSha1 = "";
  let revIdSeen = false;

  const startCapture = (field: string, keep: boolean, back: State): State => {
    cap.field = field;
    cap.end = `</${field}>`;
    cap.parts = keep ? [] : null;
    cap.keep = keep;
    resume = back;
    return State.Capturing;
  };

  const toWikiPage = (p: PageAccum | null): WikiPage | null => {
    if (p === null || p.bestText === null) return null;
    if (!namespaces.has(p.ns)) return null;
    const era = eraWinner(p);
    return {
      title: p.title,
      ns: p.ns,
      wikitext: decodeEntities(p.bestText),
      timestamp: p.bestTimestamp,
      eraWikitext: era === null ? null : decodeEntities(era.text),
      eraTimestamp: era === null ? "" : era.ts,
      redirectAttr: p.redirectAttr,
    };
  };

  for await (const chunk of chunks) {
    buf = pos > 0 ? buf.slice(pos) + chunk : buf + chunk;
    pos = 0;

    scan: for (;;) {
      switch (state) {
        case State.OutsidePage: {
          const at = buf.indexOf("<page>", pos);
          if (at === -1) {
            // Keep only enough tail to not split "<page>".
            pos = Math.max(pos, buf.length - 6);
            break scan;
          }
          pos = at + 6;
          page = {
            title: "",
            ns: Number.NaN,
            redirectAttr: null,
            bestTimestamp: "",
            bestRevId: -1,
            bestText: null,
            eraCands: [],
            revs: [],
          };
          state = State.InPage;
          continue;
        }

        case State.SkippingPage: {
          const at = buf.indexOf("</page>", pos);
          if (at === -1) {
            pos = Math.max(pos, buf.length - 7);
            break scan;
          }
          pos = at + 7;
          state = State.OutsidePage;
          continue;
        }

        case State.Capturing: {
          const at = buf.indexOf(cap.end, pos);
          if (at === -1) {
            // Drain what is certainly not part of the closing tag.
            const safe = Math.max(pos, buf.length - cap.end.length + 1);
            if (cap.parts !== null && safe > pos) cap.parts.push(buf.slice(pos, safe));
            pos = safe;
            break scan;
          }
          if (cap.parts !== null) cap.parts.push(buf.slice(pos, at));
          pos = at + cap.end.length;
          const value = cap.parts === null ? "" : cap.parts.join("");
          cap.parts = null;
          state = resume;
          if (page !== null) {
            switch (cap.field) {
              case "title":
                page.title = decodeEntities(value).replace(/_/g, " ").trim();
                break;
              case "ns": {
                const block = page;
                block.ns = Number.parseInt(value.trim(), 10);
                if (!namespaces.has(block.ns)) {
                  page = null;
                  state = State.SkippingPage;
                  if (stats !== undefined) stats.pagesSkipped++;
                  break;
                }
                if (stats !== undefined) stats.blocksSeen++;
                // Title and ns are both known now, and revisions have not
                // started, so this is where a continuation block rejoins the
                // page it continues: adopt the pending accumulator and let
                // `beats` go on discarding anything older than its best.
                const prev = held.pending;
                if (prev !== null && prev.ns === block.ns && prev.title === block.title) {
                  page = prev;
                  held.pending = null;
                } else if (prev !== null) {
                  held.pending = null;
                  const done = toWikiPage(prev);
                  if (done !== null) yield done;
                }
                break;
              }
              case "id":
                revId = Number.parseInt(value.trim(), 10);
                if (!Number.isFinite(revId)) revId = -1;
                break;
              case "timestamp":
                revTs = value.trim();
                break;
              case "text": {
                if (!cap.keep) break;
                const block = page;
                if (beats(revTs, revId, block.bestTimestamp, block.bestRevId)) {
                  block.bestText = value;
                  block.bestTimestamp = revTs;
                  block.bestRevId = revId;
                }
                // Era slot: pre-cutoff, and not a revision where the page was a
                // redirect. The revert test needs revisions that have not
                // arrived yet, so it waits until the page is finished.
                if (
                  revTs !== "" &&
                  revTs < eraCutoff &&
                  eraWants(block.eraCands, revTs, revId) &&
                  // Decoded, so this reads the same string the build's own
                  // redirect decision reads.
                  redirectTarget(decodeEntities(value)) === null
                ) {
                  eraOffer(block.eraCands, { ts: revTs, id: revId, text: value });
                }
                break;
              }
              case "sha1":
                revSha1 = value.trim();
                break;
            }
          }
          continue;
        }

        case State.InPage:
        case State.InRevision: {
          const lt = buf.indexOf("<", pos);
          if (lt === -1) {
            pos = buf.length;
            break scan;
          }
          const gt = buf.indexOf(">", lt + 1);
          if (gt === -1) {
            pos = lt; // incomplete tag, wait for more
            break scan;
          }
          const tag = buf.slice(lt, gt + 1);
          pos = gt + 1;
          const name = tagNameOf(tag);
          const closing = tag.charCodeAt(1) === 0x2f;

          if (state === State.InPage) {
            if (!closing && name === "title") {
              state = startCapture("title", true, State.InPage);
            } else if (!closing && name === "ns") {
              state = startCapture("ns", true, State.InPage);
            } else if (!closing && name === "redirect") {
              // A continuation block need not repeat it, so a missing one never
              // clears a target already seen.
              const target = attrOf(tag, "title");
              if (page !== null && target !== null) page.redirectAttr = target;
            } else if (!closing && name === "revision") {
              revId = -1;
              revTs = "";
              revSha1 = "";
              revIdSeen = false;
              state = State.InRevision;
            } else if (closing && name === "page") {
              // Not finished: the next block may continue this page.
              if (page !== null) {
                held.pending = page;
                page = null;
              }
              state = State.OutsidePage;
            }
            continue;
          }

          // State.InRevision
          if (!closing && name === "id" && !revIdSeen) {
            revIdSeen = true;
            state = startCapture("id", true, State.InRevision);
          } else if (!closing && name === "sha1" && !tag.endsWith("/>")) {
            state = startCapture("sha1", true, State.InRevision);
          } else if (!closing && name === "timestamp") {
            state = startCapture("timestamp", true, State.InRevision);
          } else if (!closing && name === "contributor") {
            // Contributor also carries an <id>; do not mistake it for the rev id.
            revIdSeen = true;
          } else if (!closing && name === "text") {
            if (tag.endsWith("/>")) {
              // Deleted or empty text: nothing to capture.
            } else {
              // Keep the body if it can still win either slot. Redirect-ness is
              // only knowable once the body is here, so an era candidate is
              // captured first and filtered after.
              const win =
                page !== null &&
                (beats(revTs, revId, page.bestTimestamp, page.bestRevId) ||
                  (revTs !== "" &&
                    revTs < eraCutoff &&
                    eraWants(page.eraCands, revTs, revId)));
              state = startCapture("text", win, State.InRevision);
            }
          } else if (closing && name === "revision") {
            // One ledger entry per revision, whether or not it had a <sha1>.
            if (page !== null) page.revs.push({ ts: revTs, id: revId, sha1: revSha1 });
            state = State.InPage;
          } else if (closing && name === "page") {
            if (page !== null) {
              held.pending = page;
              page = null;
            }
            state = State.OutsidePage;
          }
          continue;
        }
      }
    }
  }

  // End of stream: nothing follows to close the last page. A block still
  // mid-parse (a truncated dump) is dropped, as it was before.
  const last = toWikiPage(held.pending);
  held.pending = null;
  if (last !== null) yield last;
}

/** Decode a byte stream to text chunks, reporting bytes consumed. */
export async function* decodeUtf8(
  bytes: AsyncIterable<Uint8Array>,
  onBytes?: (total: number) => void,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  for await (const chunk of bytes) {
    total += chunk.byteLength;
    if (onBytes) onBytes(total);
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

/** Turn a string into an async iterable of fixed-size chunks (tests). */
export async function* chunked(
  input: string,
  size: number,
): AsyncGenerator<string, void, undefined> {
  for (let i = 0; i < input.length; i += size) yield input.slice(i, i + size);
}
