/**
 * The gate in front of the public dashboard.
 *
 * `docs/PUBLIC-DASHBOARD.md` describes the eventual shape: an R2 bucket behind
 * a custom domain, cache rules carrying the TTLs, and no Worker in the read
 * path at all. That shape needs a zone. Until there is a domain, this Worker
 * stands in for it and buys one thing the zoneless shape cannot otherwise
 * have: a password. Cloudflare's access controls, WAF, and cache are all
 * custom-domain features — on an `r2.dev` development URL the bucket is
 * world-readable to anyone who learns the hostname, which is precisely what a
 * pre-gate deploy must not be.
 *
 * So: one origin, serving the SPA from Static Assets and the published
 * artifacts from a private bucket binding, with a shared secret in front of
 * both. The bucket's own public development URL stays disabled; this Worker's
 * binding is the only way in.
 *
 * THIS FILE IS TEMPORARY. It is not what launches. The launch shape has no
 * Worker in the read path at all, so a traffic spike is absorbed by the edge
 * cache in front of immutable objects rather than becoming per-request compute
 * — that is the whole point of the push-based design, and this file trades it
 * away to buy a password. Retiring it is item 85 in `docs/FOLLOW-UPS.md`.
 *
 * What this is not: a security boundary worth more than the secret behind it.
 * One shared password, no identity, no revocation short of rotating it. That
 * is the correct weight for a private preview shared with named people, and it
 * is why the content gate (issue #10) still binds the first genuinely public
 * deploy. When there is a domain, Cloudflare Access replaces this file and the
 * read path goes back to what the design doc says.
 */

export interface Env {
  /** Shared secret. `wrangler secret put DASHBOARD_PASSWORD`. */
  DASHBOARD_PASSWORD: string;
  /** The published artifacts. Private; no public development URL. */
  PUBLIC_BUCKET: R2Bucket;
  /** The built SPA, deferred to for everything that is not `/v1/`. */
  ASSETS: Fetcher;
}

/** The cookie the browser carries once a visitor has proven the secret. */
const COOKIE = "wb_pass";

/**
 * A day. Long enough that a shared link works for as long as someone is
 * looking at it, short enough that a rotated password takes effect without
 * chasing anyone's browser.
 */
const SESSION_SECONDS = 86_400;

/**
 * The immutable artifacts address their own content: a generation or a run
 * version never changes under a key. Everything else is the fast lane, and a
 * reader may not hold it for longer than the publisher's own cadence.
 *
 * Bun's `S3Client` cannot send `Cache-Control` on a PUT, so the design doc
 * puts these TTLs in zone cache rules. Zoneless, the Worker sets them on the
 * way out instead, which lands them in the *browser* cache rather than
 * Cloudflare's. That is a weaker guarantee and a deliberate one: with a
 * handful of authenticated viewers the bucket reads are free, and edge caching
 * an authenticated response is a footgun that is not worth arming here.
 */
function cacheControl(path: string): string {
  if (path.startsWith("/v1/snap/") || path.startsWith("/v1/run/")) {
    return "private, max-age=31536000, immutable";
  }
  if (path.startsWith("/tiles/")) return TILE_CACHE_CONTROL;
  return "private, max-age=30";
}

/** R2 stores what the publisher gave it; the extension is the reliable signal. */
function contentType(path: string): string {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

/**
 * Minimap tiles, uploaded by `infra/publish-tiles.ts` under the same path the
 * private viewer serves them on, so the SPA asks for one URL in both shapes.
 *
 * The two constants are the viewer's own (`runner/viewer/tiles.ts`,
 * `TILE_PUBLIC_CACHE_CONTROL` / `TILE_PUBLIC_ROBOTS`), copied rather than
 * imported: that module reads the filesystem and cannot be bundled into a
 * Worker. `gate.test.ts` imports it to pin that these two have not drifted.
 *
 * The pattern is bare integers only — `..`, a leading `-`, an encoded
 * separator and `tiles/manifest.json` all fail it — so the only thing
 * reachable under this prefix is a tile, and nothing here lists a bucket.
 */
const TILE_CACHE_CONTROL = "private, max-age=3600";
const TILE_ROBOTS = "noindex";
const TILE_PATH = /^\/tiles\/\d+\/\d+_\d+\.png$/;

/**
 * Constant-time compare over UTF-8 bytes.
 *
 * Written out rather than reaching for `crypto.subtle.timingSafeEqual`, which
 * exists on workerd and not in Bun — and this file's tests are `bun test` like
 * every other suite in the repository. The early return on a length mismatch
 * leaks the length of the secret, which is not the part worth protecting.
 */
export function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.byteLength; i += 1) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/**
 * The cookie carries a derivation of the password rather than the password,
 * so a leaked cookie jar does not hand over the thing that would be typed
 * into a login form or pasted into a shared link.
 */
async function sessionToken(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`wrathbench-public\u0000${password}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Three ways to present the secret, in the order they are checked:
 *
 * - the session cookie, which is how every request after the first arrives;
 * - `?k=<secret>` in the URL, which is what makes a link shareable — the
 *   operator sends one URL and the recipient never types anything;
 * - HTTP Basic, so `curl -u :<secret>` works for a smoke test.
 */
async function authorize(request: Request, url: URL, env: Env): Promise<"ok" | "set-cookie" | "no"> {
  const expected = await sessionToken(env.DASHBOARD_PASSWORD);
  const cookie = readCookie(request.headers.get("cookie"), COOKIE);
  if (cookie !== null && secretsMatch(cookie, expected)) return "ok";

  const fromQuery = url.searchParams.get("k");
  if (fromQuery !== null && secretsMatch(fromQuery, env.DASHBOARD_PASSWORD)) return "set-cookie";

  const basic = request.headers.get("authorization");
  if (basic !== null && basic.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(basic.slice("Basic ".length));
    } catch {
      return "no";
    }
    const supplied = decoded.slice(decoded.indexOf(":") + 1);
    if (secretsMatch(supplied, env.DASHBOARD_PASSWORD)) return "ok";
  }

  return "no";
}

/**
 * The wall. A browser gets a form it can type into; anything asking for JSON
 * gets a flat 401, because an SPA fetch that receives an HTML login page is a
 * confusing failure and a `WWW-Authenticate` challenge on a subresource
 * produces a browser dialog in the middle of a page load.
 */
function challenge(request: Request, url: URL): Response {
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  // `/tiles/` joins `/v1/` for the same reason: an <img> or a fetch handed an
  // HTML login page fails confusingly, and the SPA already treats a tile that
  // does not arrive as a tile it draws a grid square for instead.
  if (wantsJson || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/tiles/")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const body = `<!doctype html><meta charset="utf-8"><title>WrathBench</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark }
  body { background:#0e1116; color:#c9d1d9; font:16px/1.5 ui-sans-serif,system-ui,sans-serif;
         display:grid; place-items:center; min-height:100vh; margin:0 }
  form { display:grid; gap:.75rem; width:min(20rem,90vw) }
  h1 { font-size:1rem; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:#8b949e; margin:0 }
  input,button { font:inherit; padding:.6rem .7rem; border-radius:6px; border:1px solid #30363d; background:#161b22; color:inherit }
  button { background:#1f6feb; border-color:#1f6feb; cursor:pointer }
</style>
<form method="GET" action="">
  <h1>WrathBench &mdash; private preview</h1>
  <input type="password" name="k" placeholder="Password" autofocus aria-label="Password">
  <button type="submit">Enter</button>
</form>`;
  return new Response(body, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Serve one published artifact out of the private bucket. */
async function serveArtifact(request: Request, url: URL, env: Env): Promise<Response> {
  const key = url.pathname.replace(/^\/+/, "");
  // No `range:` here on purpose. Honouring a Range would mean answering 206
  // with a `Content-Range`, and the published artifacts are small JSON that no
  // reader asks for in pieces — passing the header through while still
  // answering 200 would hand a partial body to a client told it was complete.
  const object = await env.PUBLIC_BUCKET.get(key, { onlyIf: request.headers });

  if (object === null) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", contentType(url.pathname));
  headers.set("cache-control", cacheControl(url.pathname));
  headers.set("etag", object.httpEtag);
  if (url.pathname.startsWith("/tiles/")) headers.set("x-robots-tag", TILE_ROBOTS);

  // `onlyIf` matched, so R2 returned the metadata without a body.
  if (!("body" in object) || object.body === null) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" },
      });
    }

    // A Worker with no secret bound would otherwise compare against undefined
    // and let everyone through. Fail closed and say why, once, to whoever is
    // deploying rather than to a visitor.
    if (typeof env.DASHBOARD_PASSWORD !== "string" || env.DASHBOARD_PASSWORD === "") {
      return new Response(JSON.stringify({ error: "gate not configured" }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Answered before the gate, because a crawler that gets a 401 login form
    // instead of a robots.txt has been told nothing. Nothing here is meant to
    // be indexed while the gate stands.
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /tiles/\nDisallow: /\n", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": TILE_ROBOTS,
        },
      });
    }

    const verdict = await authorize(request, url, env);
    if (verdict === "no") return challenge(request, url);

    // The secret arrived in the URL. Trade it for a cookie and bounce to a
    // clean address, so it stops living in the address bar, the history, and
    // every `Referer` the page goes on to send.
    if (verdict === "set-cookie") {
      const clean = new URL(url);
      clean.searchParams.delete("k");
      const token = await sessionToken(env.DASHBOARD_PASSWORD);
      return new Response(null, {
        status: 303,
        headers: {
          location: `${clean.pathname}${clean.search}`,
          "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`,
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname.startsWith("/v1/")) return await serveArtifact(request, url, env);

    // Tiles. Anything under the prefix that is not a tile path is a 404 and
    // never the SPA's index.html: falling through would answer the manifest
    // key, or a probe, with a 200 page.
    if (url.pathname.startsWith("/tiles/")) {
      if (!TILE_PATH.test(url.pathname)) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return await serveArtifact(request, url, env);
    }

    // Everything else is the SPA. `not_found_handling` gives deep links their
    // index.html without this Worker knowing the client router's shape.
    return await env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
