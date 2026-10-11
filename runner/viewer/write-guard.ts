/**
 * The viewer's guard on writes: what keeps a web page on another site from
 * writing to the viewer through a browser that can reach it.
 *
 * The private viewer has no login (`config-api.ts`, "Operator-only"): it is
 * reachable by anything on the LAN it is served to, and so by any web page a
 * browser on that LAN happens to open. Such a page cannot read the viewer's
 * answers, but without a guard it could still SEND a write — a form post or a
 * `text/plain` fetch is a "simple" request the browser sends cross-site without
 * asking anyone. Three checks close that, on every unsafe method (anything but
 * GET, HEAD and OPTIONS) on every path, whether or not a route writes:
 *
 * - `Content-Type: application/json`, required. A cross-site page can only send
 *   JSON after a CORS preflight, and the viewer never grants one — no route
 *   answers with an `Access-Control-Allow-*` header.
 * - `Origin`, when the browser sent one, must be the viewer's own host. Browsers
 *   send it on every unsafe request, same-origin included, so the dashboard's
 *   own writes carry it and match. It is compared by host and port, not scheme:
 *   behind the TLS ingress the browser's origin is https while the request the
 *   viewer sees is http, and the Host header is what both share.
 * - `Sec-Fetch-Site: cross-site`, refused outright.
 *
 * What this is not: authentication. A client that is not a browser sends what
 * it likes and is not what this guards against; the viewer's posture for those
 * is the network it is served on. Nor does it stop DNS rebinding, where the
 * attacking page and the viewer share an origin: that needs a Host allowlist
 * or a login in front of the viewer.
 */

/** Methods that change nothing, and so are never refused here. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuse(status: 403 | 415, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** `host[:port]` as a URL of the given scheme would spell it (default port dropped, lowercased), or null. */
function normalHost(scheme: string, host: string): string | null {
  try {
    return new URL(`${scheme}//${host}`).host;
  } catch {
    return null;
  }
}

/**
 * The refusal for a write that did not come from the viewer's own pages, or
 * null when the request may proceed. Safe methods always proceed.
 */
export function writeGuard(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site.trim().toLowerCase() === "cross-site") {
    return refuse(403, "a cross-site write is refused");
  }
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let from: URL | null = null;
    try {
      from = new URL(origin);
    } catch {
      from = null;
    }
    // `Origin: null` (a sandboxed frame, a file:// page) parses to an opaque origin with no host.
    const own = [req.headers.get("host"), req.headers.get("x-forwarded-host"), new URL(req.url).host]
      .filter((h): h is string => h !== null && h.length > 0)
      .map((h) => (from === null ? null : normalHost(from.protocol, h.split(",")[0]!.trim())));
    if (from === null || from.host.length === 0 || !own.includes(from.host)) {
      return refuse(403, "a write from another origin is refused");
    }
  }
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    return refuse(415, "a write must be sent as application/json");
  }
  return null;
}
