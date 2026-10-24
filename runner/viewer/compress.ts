/**
 * Content-encoding for the viewer's JSON bodies.
 *
 * Nothing in front of the viewer compresses (operator, 2026-10-24: in the
 * viewer, not at the ingress), and its listing bodies are megabytes of JSON
 * that shrink 8–17× — `/api/runs` 2.4 MB to ~200 KB, a freeplay character
 * 7 MB to ~730 KB — on a page that polls some of them every few seconds.
 *
 * Only JSON, and only past `COMPRESS_MIN_BYTES`: a small body costs more to
 * compress than it saves. Never the SSE tail: it is a stream that must flush
 * per event, and reading its body to compress it would wait forever. Brotli
 * where the client takes it, gzip otherwise, and the body untouched when it
 * asks for neither — which is what the in-process callers (the snapshot
 * publisher, the dashboard render rig, every test) send, so they keep reading
 * plain bodies.
 */

import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/** Below this a body is sent as it is. */
export const COMPRESS_MIN_BYTES = 8 * 1024;

/**
 * Brotli quality. Four is the knee for JSON of this shape: most of the ratio
 * of the top levels at a small fraction of their time, so a 7 MB body
 * compresses in tens of milliseconds, off the event loop (zlib's thread pool).
 */
export const BROTLI_QUALITY = 4;

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

export type Encoding = "br" | "gzip";

/**
 * The encoding to answer `Accept-Encoding` with, or null for none.
 *
 * Honours `q`: `br;q=0` refuses brotli outright, and the higher weight wins
 * between the two, brotli on a tie. `*` stands for whichever of the two is not
 * named. Anything that will not parse is no preference.
 */
export function negotiateEncoding(header: string | null): Encoding | null {
  if (header === null || header.length === 0) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName?.trim().toLowerCase() ?? "";
    if (name.length === 0) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m !== null) {
        const v = Number(m[1]);
        weight = Number.isFinite(v) ? v : 0;
      }
    }
    q.set(name, weight);
  }
  const weightOf = (name: Encoding): number => q.get(name) ?? q.get("*") ?? 0;
  const br = weightOf("br");
  const gzipW = weightOf("gzip");
  if (br <= 0 && gzipW <= 0) return null;
  return br >= gzipW ? "br" : "gzip";
}

export async function encode(body: Uint8Array, encoding: Encoding): Promise<Uint8Array> {
  if (encoding === "br") {
    return await brotli(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return await gz(body, { level: 6 });
}

/** Whether a response is one this layer may encode: JSON, with a body, not already encoded. */
function encodable(req: Request, res: Response): boolean {
  if (req.method === "HEAD" || res.body === null) return false;
  if (res.status === 204 || res.status === 304) return false;
  if (res.headers.has("content-encoding")) return false;
  const type = res.headers.get("content-type") ?? "";
  return type.startsWith("application/json");
}

/**
 * The response, compressed when the request allows it and the body is JSON
 * worth compressing. Every JSON response says `Vary: Accept-Encoding`, the
 * small ones too, so a cache between here and the browser never hands an
 * encoded body to a client that did not ask for one.
 *
 * Anything that is not JSON — the SSE tail above all, and tiles, the SPA's
 * files, plain text — is returned untouched, its body never read.
 */
export async function compressResponse(req: Request, res: Response): Promise<Response> {
  if (!encodable(req, res)) return res;
  const headers = new Headers(res.headers);
  headers.append("vary", "Accept-Encoding");
  const encoding = negotiateEncoding(req.headers.get("accept-encoding"));
  // Not asked for: the body passes through unread.
  if (encoding === null) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  const body = new Uint8Array(await res.arrayBuffer());
  headers.delete("content-length");
  if (body.length < COMPRESS_MIN_BYTES) {
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  }
  const out = await encode(body, encoding);
  headers.set("content-encoding", encoding);
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}
