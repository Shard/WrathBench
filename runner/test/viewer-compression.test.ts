/**
 * The viewer compresses its JSON bodies, and nothing else.
 *
 * Negotiated off `Accept-Encoding` (brotli first, gzip otherwise, `q=0`
 * honoured), past a size floor, always with `Vary: Accept-Encoding`; and never
 * the SSE tail, whose body must stream rather than be read whole.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createApi } from "../viewer/api";
import { COMPRESS_MIN_BYTES, compressResponse, negotiateEncoding } from "../viewer/compress";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const RUN = "big-run";

/** A run whose feed window is well past the compression floor. */
function fixture(): string {
  const runs = tempDir("viewer-compress-");
  const dir = join(runs, RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: RUN, startedAt: 1000, config: { model: "m" } }));
  const lines: object[] = [{ ts: 1000, t: "meta", runId: RUN }];
  for (let i = 0; i < 300; i++) lines.push({ ts: 1001 + i, t: "snippet", turn: i, code: `await sdk.moveTo(${i}, ${i * 2}, ${i * 3});` });
  writeFileSync(join(dir, "trajectory.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return runs;
}

function api(runs: string): (r: Request) => Promise<Response> {
  return createApi({ runsDir: runs, tilesDir: join(runs, "..", "minimap"), moduleUrl: "http://127.0.0.1:1" });
}

const ENTRIES = `http://x/api/run/${RUN}/entries?from=0&limit=500`;

describe("negotiateEncoding", () => {
  test("prefers brotli, honours weights and refusals, and takes no header as none", () => {
    expect(negotiateEncoding(null)).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("br;q=0.5, gzip;q=0.8")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0, br;q=0")).toBeNull();
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("br;q=0, *")).toBe("gzip");
  });
});

describe("compressed JSON", () => {
  test("a large body is brotli for a client that takes it, and decodes to the plain body", async () => {
    const handle = api(fixture());
    const plain = await handle(new Request(ENTRIES));
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toContain("Accept-Encoding");
    const text = await plain.text();
    expect(text.length).toBeGreaterThan(COMPRESS_MIN_BYTES);

    const br = await handle(new Request(ENTRIES, { headers: { "accept-encoding": "gzip, deflate, br" } }));
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toContain("Accept-Encoding");
    expect(br.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await br.arrayBuffer());
    expect(bytes.length).toBeLessThan(text.length / 4);
    expect(brotliDecompressSync(bytes).toString("utf8")).toBe(text);
  });

  test("gzip where brotli is refused", async () => {
    const handle = api(fixture());
    const text = await (await handle(new Request(ENTRIES))).text();
    const gz = await handle(new Request(ENTRIES, { headers: { "accept-encoding": "br;q=0, gzip" } }));
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString("utf8")).toBe(text);
  });

  test("a small body is sent as it is, still varying on the header", async () => {
    const handle = api(fixture());
    const res = await handle(new Request("http://x/api/info", { headers: { "accept-encoding": "br" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(((await res.json()) as { service: string }).service).toBe("wrathbench-viewer");
  });

  test("the SSE tail is never encoded or buffered", async () => {
    const handle = api(fixture());
    const res = await handle(new Request(`http://x/api/run/${RUN}/stream`, { headers: { "accept-encoding": "br, gzip" } }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    // The hello arrives at once: the body streams, it is not read whole first.
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(first.startsWith("data: ")).toBe(true);
    expect(JSON.parse(first.slice(6).trim())).toMatchObject({ hello: RUN, total: 301 });
  });

  test("plain text is untouched", async () => {
    const runs = fixture();
    writeFileSync(join(runs, RUN, "scratchpad.md"), "x".repeat(COMPRESS_MIN_BYTES * 2));
    const res = await api(runs)(new Request(`http://x/api/run/${RUN}/scratchpad`, { headers: { "accept-encoding": "br" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect((await res.text()).length).toBe(COMPRESS_MIN_BYTES * 2);
  });
});

describe("compressResponse", () => {
  const big = JSON.stringify({ xs: Array.from({ length: 2000 }, (_, i) => i) });
  const req = new Request("http://x/", { headers: { "accept-encoding": "br" } });

  test("a body with a strong ETag is left as it is: the tag names those exact bytes", async () => {
    const res = await compressResponse(req, new Response(big, { headers: { "content-type": "application/json", etag: '"abc"' } }));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(big);
  });

  test("a weak ETag is kept on the encoded body", async () => {
    const res = await compressResponse(req, new Response(big, { headers: { "content-type": "application/json", etag: 'W/"abc"' } }));
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("etag")).toBe('W/"abc"');
  });
});
