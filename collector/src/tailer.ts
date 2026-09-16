/**
 * Reading a JSONL file from an offset, one line at a time, without ever
 * holding the file.
 *
 * The largest trajectory in the corpus is 669 MB. Nothing in this process may
 * assume a file fits in memory, so the read is a sliding window over
 * `Bun.file(path).slice(...)` and the only thing held across chunks is the
 * bytes after the last newline — which is at most one line, and a line is
 * something we have to be able to hold anyway to parse it.
 *
 * A live trajectory's last line is routinely half-written. It is left in
 * `pending` and re-read with the next chunk rather than counted, which is what
 * makes the offset this yields safe to commit: the offset only ever moves past
 * bytes that ended in a newline. (The same discipline `TrajectoryTail.scan`
 * and `RunTotalsScanner` follow in the viewer, for the same reason.)
 */

export const CHUNK_BYTES = 4 * 1024 * 1024;

export interface TailedLine {
  /** The line's text, without its newline. */
  text: string;
  /** Byte offset just past this line's newline: where a resume starts. */
  endOffset: number;
}

/**
 * Yield whole lines from `from` to the file's current end.
 *
 * `size` is passed in rather than re-stat'ed so the caller reads exactly the
 * file it decided to read — a trajectory that grows mid-pass is picked up by
 * the next pass, never by a window that drifts while it is being read.
 */
export async function* tailLines(
  path: string,
  from: number,
  size: number,
  chunkBytes: number = CHUNK_BYTES,
): AsyncGenerator<TailedLine> {
  const file = Bun.file(path);
  const decoder = new TextDecoder();
  let at = from;
  /** Bytes after the last newline in what has been read. Never yielded. */
  let pending = new Uint8Array(0);
  /** Where `pending` starts in the file; the offset a whole line ends at. */
  let pendingAt = from;

  while (at < size) {
    const end = Math.min(size, at + Math.max(1, chunkBytes));
    const chunk = new Uint8Array(await file.slice(at, end).arrayBuffer());
    at = end;
    let buf: Uint8Array;
    if (pending.length === 0) {
      buf = chunk;
    } else {
      buf = new Uint8Array(pending.length + chunk.length);
      buf.set(pending);
      buf.set(chunk, pending.length);
    }
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      const line = buf.subarray(start, i);
      start = i + 1;
      pendingAt += line.length + 1;
      if (line.length > 0) yield { text: decoder.decode(line), endOffset: pendingAt };
      else yield { text: "", endOffset: pendingAt };
    }
    pending = start === buf.length ? new Uint8Array(0) : buf.slice(start);
  }
}
