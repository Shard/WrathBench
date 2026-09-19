/**
 * Where a smoke finds the module.
 *
 * One spelling for all of them: inside the runner container (compose service
 * or the cluster's runner pod) the module is `worldserver:8086` on the
 * container network, and that is the default. `MODULE_HOST` / `MODULE_PORT`
 * override it — the documented handle for pointing a smoke somewhere else —
 * and they always win, so a smoke run inside a pod behaves the same whatever
 * else is in the environment.
 *
 * `WRATHBENCH_MODULE_URL` is consulted only when neither is set. It is the
 * harness's own name for the same endpoint (docs/RUNBOOK.md), so a host-side
 * `bun infra/smoke/<name>.ts` picks up the .env value Bun autoloads instead of
 * trying to resolve a container hostname. Inside the containers the chart and
 * compose set it to the same `http://worldserver:8086`, so nothing moves.
 *
 * Empty is unset throughout, the same rule lib/auth.ts applies to the secret.
 */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** The module's HTTP origin, with no trailing slash. */
export function moduleBase(): string {
  const host = env("MODULE_HOST");
  const port = env("MODULE_PORT");
  if (host === undefined && port === undefined) {
    const url = env("WRATHBENCH_MODULE_URL");
    if (url !== undefined) return url.replace(/\/+$/, "");
  }
  return `http://${host ?? "worldserver"}:${port ?? "8086"}`;
}

/** The same origin as a WebSocket URL, for `/events`. */
export function moduleWsBase(): string {
  return moduleBase().replace(/^http/, "ws");
}
