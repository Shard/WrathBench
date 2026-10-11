/**
 * What the two CLI drivers do identically.
 *
 * `adapter-claude.ts` and `adapter-codex.ts` mirror each other invariant for
 * invariant and differ only where the CLIs do (runner/README.md, "The codex
 * driver"). Where the code is the same code, it lives here once, so a fix to
 * process teardown cannot land on one driver and miss the other.
 */

/**
 * Signal the CLI's whole process group, falling back to the process itself.
 *
 * The group is the point: the CLI spawns the MCP bridge, and killing only the
 * CLI leaves that grandchild reparented to init. `process.kill(-pid)` needs the
 * child to lead its own group, which is what `detached` buys.
 */
export function signalGroup(
  proc: { pid: number; kill: (sig: NodeJS.Signals) => void },
  sig: NodeJS.Signals,
): void {
  try {
    process.kill(-proc.pid, sig);
    return;
  } catch {
    // no such group (already reaped, or not detached): fall through
  }
  try {
    proc.kill(sig);
  } catch {
    // already gone
  }
}

/**
 * The plumbing a CLI child needs from the runner's environment to run at all,
 * and nothing that authenticates anything: where binaries are, a home, a temp
 * directory, the user, shell, terminal, timezone and locale, and — only when
 * the deployment sets them — the proxy and CA-bundle variables the CLI needs
 * to reach its own API.
 *
 * Each driver builds its child environment from this list and adds back,
 * explicitly, its own config directory, the one lane credential the run
 * bills, and the run-controlled knobs. Nothing else of the runner's crosses:
 * not a provider key, not the module's port secret, not the database or the
 * derived store's password. An allowlist rather than a denylist because the
 * runner's environment is whatever `.env` or the pod holds — a denylist passes
 * every credential nobody thought to name, and the CLI is the model's own
 * process (the codex CLI also snapshots its environment into its home).
 *
 * The MCP bridge the CLI launches (`mcp-bridge.ts`) inherits this environment
 * and reads nothing from it: it is told the runner's port on argv and is run by
 * the interpreter's absolute path, and the MCP server itself — the sandbox, the
 * module URL, the session token and secret — lives in the runner process.
 */
export const CLI_BASE_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "LANG",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/** `CLI_BASE_ENV` and every `LC_*` locale variable, copied from `parent` where set. */
export function cliBaseEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (CLI_BASE_ENV.includes(k) || /^LC_[A-Z]+$/.test(k)) out[k] = v;
  }
  return out;
}
