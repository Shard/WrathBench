/**
 * The path scrub for published strings: container-internal absolute paths are
 * made repo-relative, and nothing else about the string changes.
 *
 * The 2026-09-11 acceptance readback found 45 container-internal paths
 * (`/wrathbench/sdk/src/...`, `/wrathbench/runner/...`) in the public set —
 * sandbox stack traces, console lines and snippet code, arriving through the
 * model- and harness-authored surface `docs/PUBLIC-DASHBOARD.md` calls the
 * residual. They name the runner image's own working directory
 * (`infra/docker/runner.Dockerfile`, `WORKDIR /wrathbench`), not the
 * operator's host, and the file they point at is a file in this repository.
 * The operator's call that day: strip the install prefix so such a path reads
 * as the repo-relative one it already is (`sdk/src/client.ts:123`), and leave
 * the rest of the text as written. This is a path scrub, not prose filtering —
 * the 2026-08-30 decision that model prose is published as written stands.
 *
 * Any other absolute path is untouched here, because it is "Never" published
 * at all (docs/DATA-AND-LEGAL.md): the operator's home, a host mount, anything
 * under a system root. Those are the verifier's business, which is why the
 * root list below is shared with `infra/publish-accept.ts` rather than written
 * twice.
 */

/**
 * The runner image's working directory, from `infra/docker/runner.Dockerfile`
 * (`WORKDIR /wrathbench`) — the one prefix this module strips. The compose and
 * chart runtimes inherit it from the image; `WRATHBENCH_IN_CONTAINER=1` says a
 * process is inside one, but the prefix is a property of the image and is
 * pinned here rather than read from the environment, because the strings being
 * scrubbed were written by some other pod at some other time.
 */
export const CONTAINER_ROOT = "/wrathbench";

/**
 * Every absolute-path root the readback treats as local, `wrathbench` included.
 *
 * The container root STAYS on this list after the scrub: a published string
 * that still carries `/wrathbench/…` means the scrub did not run over it, and
 * the readback reporting it is exactly how that regression is noticed. Do not
 * drop it on the grounds that the scrub handles it — that would make the
 * verifier blind to the scrub failing.
 */
export const LOCAL_PATH_ROOTS: readonly string[] = [
  "home",
  "root",
  "Users",
  "usr",
  "var",
  "etc",
  "srv",
  "opt",
  "mnt",
  "media",
  "tmp",
  "proc",
  "wrathbench",
];

/**
 * `/wrathbench/` where a path can start, and nowhere else.
 *
 * The lookbehind rejects a preceding path or word character, so the operator's
 * own worktree — `/home/mark/git/wrathbench/sdk/src/client.ts` — is left whole
 * and stays a filesystem-path finding, which is what "Never" means for it. The
 * lookahead requires a first segment character, so a bare `/wrathbench` is not
 * rewritten to nothing. Global, and idempotent: the replacement can never
 * produce a new match, since what it leaves behind starts with a path segment
 * rather than a separator.
 */
const CONTAINER_PREFIX = /(?<![A-Za-z0-9_.~\-/])\/wrathbench\/(?=[A-Za-z0-9_.~-])/g;

/** One string with the container install prefix stripped. Pure. */
export function scrubPathsText(s: string): string {
  return s.includes(CONTAINER_ROOT) ? s.replace(CONTAINER_PREFIX, "") : s;
}

/**
 * A deep copy of `v` with every string scrubbed — objects, arrays, nesting.
 *
 * Applied at the exported projectors rather than at a list of free-text
 * fields: the rewrite touches no structure and is a no-op on any string
 * without the prefix, so it cannot change what the allowlist emits, and no
 * field added later has to remember to opt in.
 */
export function scrubPathsValue<T>(v: T): T {
  if (typeof v === "string") return scrubPathsText(v) as T;
  if (Array.isArray(v)) return v.map((x) => scrubPathsValue(x)) as unknown as T;
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = scrubPathsValue(val);
  return out as T;
}
