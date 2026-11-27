/**
 * The viewer's one JSON response shape: every route it answers, the read-only
 * API and the admin and config writes alike, is uncached JSON. A leaf, so the
 * route modules share it without importing one another.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function notFound(msg: string): Response {
  return json({ error: msg }, 404);
}

export function withheld(): Response {
  return json({ error: "withheld in public mode" }, 403);
}
