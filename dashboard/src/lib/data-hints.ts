/**
 * The public build's head hints for the data host: a preconnect to it and a
 * preload of its manifest, injected into the static `index.html` at build time
 * by the same Vite hook as the social card's tags (`vite.config.ts`).
 *
 * Every page of the public build starts by reading `v1/manifest.json` off the
 * data host (`api/snapshot-client.ts`), and without a hint that request waits
 * for the entry script to download and run. With one, the TLS handshake and
 * the manifest ride alongside the script, and the snapshot client's own fetch
 * is answered from the preload. `crossorigin` on both because the data host is
 * another origin and the client's fetch is CORS without credentials: a hint
 * without it opens a connection, or fetches a body, that the fetch cannot use.
 *
 * The private build names no data host and gets nothing; its API is
 * same-origin and already warm.
 */

/** The manifest's URL for a snapshot base, exactly as the snapshot client builds it. */
export function manifestUrl(base: string): string {
  return `${base.trim().replace(/\/+$/, "")}/v1/manifest.json`;
}

/** The `<link>` tags, or "" when the build has no snapshot base. */
export function dataHints(base: string | undefined): string {
  if (base === undefined || base.trim() === "") return "";
  const origin = new URL(base.trim()).origin;
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return [
    `<link rel="preconnect" href="${esc(origin)}" crossorigin />`,
    `<link rel="preload" href="${esc(manifestUrl(base))}" as="fetch" crossorigin />`,
  ].join("\n    ");
}
