/**
 * Where the source lives — when there is somewhere to send a reader.
 *
 * The link stays off until launch day, because a link that does not resolve is
 * a 404 with the project's name on it: worse than no link, in the footer of the
 * one page a stranger sees first. So the URL is a build-time flag rather than a
 * constant. Unset (a bare clone, the operator viewer build, the public build
 * until launch day) the footer link and the BibTeX `url` line are simply not
 * rendered; set, they are. Flipping it on is one line in `.env`
 * — `WRATHBENCH_REPO_URL`, which `infra/deploy-dashboard.sh` passes into the
 * public build as `VITE_WRATHBENCH_REPO_URL` — and no repository edit.
 *
 * A build-time env and not a runtime probe for the same reason as
 * `VITE_WRATHBENCH_SNAPSHOT_BASE`: one flag produces one bundle, and the
 * absent case dead-code-eliminates behind a constant.
 *
 * Unlike `VITE_WRATHBENCH_PUBLIC_ORIGIN`, a malformed value here does not
 * throw: an `og:image` that is not absolute breaks a card silently, whereas a
 * link is either a link or nothing. Anything that is not an http(s) URL is
 * treated as nothing, so a stray value cannot put `javascript:` in an anchor.
 */

/** The configured repository URL, or null when there is none to show. */
export function repoUrlFromEnv(env: Record<string, unknown>): string | null {
  const configured = env["VITE_WRATHBENCH_REPO_URL"];
  if (typeof configured !== "string") return null;
  const url = configured.trim().replace(/\/+$/, "");
  if (url === "") return null;
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/** Null until the link is turned on; see above. */
export const REPO_URL: string | null = repoUrlFromEnv(import.meta.env as unknown as Record<string, unknown>);

/** The short name shown as the footer link's text: `owner/repo` off the end of the URL. */
export function repoLabel(url: string): string {
  const parts = url.split("/").filter((p) => p !== "");
  return parts.slice(-2).join("/") || url;
}

/**
 * The citation, with the `url` line only when there is a repository to cite.
 * A BibTeX entry naming a URL that 404s is a citation a reader cannot follow,
 * and the entry is complete without it.
 */
export function bibtex(url: string | null): string {
  const fields = [
    "  title  = {WrathBench: An Agent Workbench for World of Warcraft}",
    "  author = {Mark Beukers}",
    "  year   = {2026}",
  ];
  if (url !== null) fields.push(`  url    = {${url}}`);
  return `@misc{beukers2026wrathbench,\n${fields.join(",\n")}\n}`;
}
