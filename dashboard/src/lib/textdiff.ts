/**
 * An edit as a compact diff: what an `edit_file` or `edit_scratchpad` call
 * replaced, drawn as the lines it took out over the lines it put in.
 *
 * The call carries the two strings whole, not a patch, so there is no hunk to
 * render. The lines both sides share at their start and end are trimmed, all
 * but a couple kept as context; what is left is the change, removed lines
 * first and added lines after, which is how an edit of a few lines reads best
 * and stays a few lines tall. Where both sides of the change are small, the
 * words that differ inside them are marked too, from a word-level longest
 * common subsequence; past that size the lines alone say it.
 */

export type DiffOp = " " | "-" | "+";

/** A half-open character range inside one line. */
export type Range = readonly [number, number];

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** The changed words of a removed or added line, when both sides were small enough to compare. */
  words?: Range[];
}

export interface LineDiff {
  lines: DiffLine[];
  /** Shared lines left out above and below the context. */
  hiddenBefore: number;
  hiddenAfter: number;
  removed: number;
  added: number;
}

/** Context kept on each side of the change. */
export const CONTEXT_LINES = 2;
/** Word highlights only when each side of the change is at most this many lines… */
const WORDS_MAX_LINES = 12;
/** …and the comparison table stays under this many cells. */
const WORDS_MAX_CELLS = 60_000;

function splitLines(s: string): string[] {
  return s.length === 0 ? [] : s.split("\n");
}

/** The diff of two texts: shared ends trimmed to context, then removed lines, then added ones. */
export function lineDiff(before: string, after: string, context = CONTEXT_LINES): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const ctxBefore = a.slice(Math.max(0, head - context), head);
  const ctxAfter = a.slice(a.length - tail, a.length - tail + Math.min(context, tail));
  const lines: DiffLine[] = [];
  for (const t of ctxBefore) lines.push({ op: " ", text: t });
  const words = removed.length > 0 && added.length > 0 && removed.length <= WORDS_MAX_LINES && added.length <= WORDS_MAX_LINES ? wordRanges(removed.join("\n"), added.join("\n")) : null;
  const rm = words === null ? null : perLine(removed, words.before);
  const ad = words === null ? null : perLine(added, words.after);
  removed.forEach((t, k) => lines.push(rm === null ? { op: "-", text: t } : { op: "-", text: t, words: rm[k]! }));
  added.forEach((t, k) => lines.push(ad === null ? { op: "+", text: t } : { op: "+", text: t, words: ad[k]! }));
  for (const t of ctxAfter) lines.push({ op: " ", text: t });
  return {
    lines,
    hiddenBefore: head - ctxBefore.length,
    hiddenAfter: tail - ctxAfter.length,
    removed: removed.length,
    added: added.length,
  };
}

/** Words, runs of space, and single punctuation marks: the units a change is marked in. */
function words(s: string): string[] {
  return s.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
}

/**
 * The character ranges of each side that the other side does not share, by a
 * longest common subsequence over words. Null when the table would be too big
 * to be worth it.
 */
function wordRanges(before: string, after: string): { before: Range[]; after: Range[] } | null {
  const x = words(before);
  const y = words(after);
  if (x.length * y.length > WORDS_MAX_CELLS) return null;
  const m = x.length;
  const n = y.length;
  // Suffix LCS lengths, so the walk below runs forwards.
  const L = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      L[i * (n + 1) + j] = x[i] === y[j] ? L[(i + 1) * (n + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (n + 1) + j]!, L[i * (n + 1) + j + 1]!);
    }
  }
  const outA: Range[] = [];
  const outB: Range[] = [];
  const mark = (out: Range[], from: number, to: number): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last[1] === from) out[out.length - 1] = [last[0], to];
    else out.push([from, to]);
  };
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) {
      pa += x[i]!.length;
      pb += y[j]!.length;
      i++;
      j++;
    } else if (j < n && (i >= m || L[i * (n + 1) + j + 1]! >= L[(i + 1) * (n + 1) + j]!)) {
      mark(outB, pb, pb + y[j]!.length);
      pb += y[j]!.length;
      j++;
    } else {
      mark(outA, pa, pa + x[i]!.length);
      pa += x[i]!.length;
      i++;
    }
  }
  return { before: outA, after: outB };
}

/** A line this much changed is marked by its colour alone: words lit across all of it say nothing more. */
const WORDS_MAX_SHARE = 0.7;

/**
 * Ranges over a joined block, cut back into its lines' own offsets.
 * Whitespace-only marks are dropped, and so are a line's marks when they
 * cover most of it.
 */
function perLine(lines: readonly string[], ranges: readonly Range[]): Range[][] {
  const out: Range[][] = lines.map(() => []);
  let start = 0;
  lines.forEach((line, k) => {
    const end = start + line.length;
    let lit = 0;
    for (const [from, to] of ranges) {
      const a = Math.max(from, start);
      const b = Math.min(to, end);
      const piece = line.slice(a - start, b - start);
      if (b > a && piece.trim().length > 0) {
        out[k]!.push([a - start, b - start]);
        lit += piece.replace(/\s+/g, "").length;
      }
    }
    if (lit > WORDS_MAX_SHARE * line.replace(/\s+/g, "").length) out[k] = [];
    start = end + 1;
  });
  return out;
}
