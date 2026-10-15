/**
 * The viewer's Host allowlist: what keeps a web page that has re-pointed its
 * own name at the viewer (DNS rebinding) from reading or writing it.
 *
 * The private viewer has no login, by the operator's choice: the network it
 * is served on is private, and `write-guard.ts` keeps another
 * site's page from writing through a browser on it. What that guard cannot see
 * is a page whose own name now resolves to the viewer's address. The browser
 * then counts the viewer as the page's own origin, so the page reads every
 * answer and its writes carry a matching `Origin`. The one thing it cannot
 * change is the name it is using: the browser still sends the attacker's
 * hostname in `Host`. So every request, on every path and every method, must
 * be addressed to a name the viewer answers to:
 *
 * - `localhost`, always. A rebinding page cannot make a browser send it, and
 *   it is what local development, a port-forward and the operator's curl use.
 * - any IP address, always. A browser sends an IP-literal `Host` only when the
 *   page's own origin is that address, and an attacker cannot serve a page from
 *   the viewer's address — rebinding needs a name. It is also what a Kubernetes
 *   probe sends (the pod IP) and what a LAN browser pointed at the viewer's
 *   address sends, so neither needs a path exemption or a setting.
 * - the names in `WRATHBENCH_VIEWER_ALLOWED_HOSTS` (comma-separated, ports
 *   ignored), or, when that is unset, the host of `WRATHBENCH_VIEWER_URL`. The
 *   chart renders the variable from the Ingress hosts.
 *
 * Only `Host` is read, never `X-Forwarded-Host`: once a page shares the
 * viewer's origin it may send that header without a preflight. The reverse
 * proxy in front of the viewer must pass the browser's `Host` through, which is
 * Traefik's default.
 *
 * A refusal is a 421 Misdirected Request: the request reached a server that
 * does not answer for that name, which is what happened, and it keeps the
 * write guard's 403 meaning "you may not write here".
 *
 * Like the write guard, this is not authentication: a client that is not a
 * browser sends whatever `Host` it likes.
 */

import { isIP } from "node:net";

export const ALLOWED_HOSTS_ENV = "WRATHBENCH_VIEWER_ALLOWED_HOSTS";

/**
 * A `Host` value (or an allowlist entry) as the bare hostname it names:
 * lowercased, port and trailing dot dropped, IPv6 kept in brackets. Null when it
 * is not a host at all.
 */
export function hostName(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || /[\s/?#@\\]/.test(value)) return null;
  try {
    const name = new URL(`http://${value}`).hostname.replace(/\.$/, "");
    return name.length === 0 ? null : name;
  } catch {
    return null;
  }
}

function isIpLiteral(name: string): boolean {
  return isIP(name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name) !== 0;
}

/** Normalise a list of names, refusing one that is not a host. */
export function hostAllowlist(names: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of names) {
    const name = hostName(raw);
    if (name === null) throw new Error(`${JSON.stringify(raw)} is not a host name`);
    out.add(name);
  }
  return out;
}

/**
 * The names this viewer answers to beyond `localhost` and IP addresses:
 * `WRATHBENCH_VIEWER_ALLOWED_HOSTS` when it is set and non-empty, else the host
 * of `WRATHBENCH_VIEWER_URL` when that is set, else none. Throws on an entry
 * that is not a host, so a typo is a startup failure rather than a lockout.
 */
export function allowedHostsFromEnv(env: Record<string, string | undefined>): string[] {
  const listed = (env[ALLOWED_HOSTS_ENV] ?? "").split(",").map((h) => h.trim()).filter((h) => h.length > 0);
  if (listed.length > 0) {
    try {
      return [...hostAllowlist(listed)];
    } catch (err) {
      throw new Error(`${ALLOWED_HOSTS_ENV}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const url = (env["WRATHBENCH_VIEWER_URL"] ?? "").trim();
  if (url.length === 0) return [];
  try {
    const name = hostName(new URL(url).host);
    return name === null ? [] : [name];
  } catch {
    return [];
  }
}

/**
 * The refusal for a request addressed to a name this viewer does not answer
 * to, or null when it may proceed. `allowed` is a `hostAllowlist`.
 */
export function hostGuard(req: Request, allowed: ReadonlySet<string>): Response | null {
  const raw = req.headers.get("host") ?? new URL(req.url).host;
  const name = hostName(raw);
  if (name !== null && (name === "localhost" || isIpLiteral(name) || allowed.has(name))) return null;
  return new Response(
    JSON.stringify({ error: `this viewer does not answer to ${JSON.stringify(raw)}; its names are set by ${ALLOWED_HOSTS_ENV}` }),
    { status: 421, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } },
  );
}
