/**
 * Streaming MediaWiki XML export parser.
 *
 * The dump is 24 GB of export-0.10 full history, so this never materialises a
 * document, a page's history, or even two revision bodies at once:
 *
 * - Pages outside the wanted namespaces are skipped with a single indexOf to
 *   `</page>`; nothing in them is decoded. That is most of a history dump.
 * - Within a page, `<id>` and `<timestamp>` precede `<text>`, so the newest
 *   revision seen so far is known before its body arrives. A revision that
 *   cannot win is skipped without being buffered or decoded. Peak memory is
 *   therefore one revision body, whatever the history depth.
 * - Selection is by (timestamp, revision id), so it does not depend on the
 *   dump's revision ordering. This dump happens to be newest-first; others are
 *   oldest-first.
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

export interface WikiPage {
  title: string;
  ns: number;
  /** Raw wikitext of the newest revision. */
  wikitext: string;
  /** Revision timestamp of the newest revision, ISO 8601, or "" if absent. */
  timestamp: string;
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

interface PageAccum {
  title: string;
  ns: number;
  redirectAttr: string | null;
  bestTimestamp: string;
  bestRevId: number;
  bestText: string | null;
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
    return {
      title: p.title,
      ns: p.ns,
      wikitext: decodeEntities(p.bestText),
      timestamp: p.bestTimestamp,
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
              case "text":
                if (cap.keep) {
                  page.bestText = value;
                  page.bestTimestamp = revTs;
                  page.bestRevId = revId;
                }
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
          } else if (!closing && name === "timestamp") {
            state = startCapture("timestamp", true, State.InRevision);
          } else if (!closing && name === "contributor") {
            // Contributor also carries an <id>; do not mistake it for the rev id.
            revIdSeen = true;
          } else if (!closing && name === "text") {
            if (tag.endsWith("/>")) {
              // Deleted or empty text: nothing to capture.
            } else {
              const win =
                page !== null && beats(revTs, revId, page.bestTimestamp, page.bestRevId);
              state = startCapture("text", win, State.InRevision);
            }
          } else if (closing && name === "revision") {
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
