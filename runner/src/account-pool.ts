/**
 * The fleet's generated game-account pool: `POOL01` … `POOLnn`, nobody naming
 * them. One number sizes it, the chart's `worldserver.pool.size` (compose:
 * `WRATHBENCH_POOL_SIZE` beside a matching allowlist), because Helm cannot read
 * the config store and the module's allowlist is rendered from values. The
 * chart hands the same number to the three places that need it: the module's
 * allowlist (`wrathbench.moduleAccounts`), the bootstrap Job, which creates
 * each missing account with its own name as its password
 * (infra/bootstrap/bootstrap.ts), and every pod that parses the fleet config,
 * as `WRATHBENCH_POOL_SIZE`, where `parseFleet` expands a config that names no
 * pool into these names.
 *
 * The pad is fixed at two digits so a pool that grows from 9 to 10 renames
 * nothing, which caps it at 99. A name is a letter and then letters and
 * digits, as every harness account's is (bootstrap's ACCOUNT_NAME).
 */

/** The env var every config-parsing pod and the bootstrap Job read the pool's size from. */
export const POOL_SIZE_ENV = "WRATHBENCH_POOL_SIZE";

/** The prefix every generated pool account carries. */
export const POOL_ACCOUNT_PREFIX = "POOL";

/** Two digits of pad: the largest pool there is. */
export const MAX_POOL_SIZE = 99;

/** The `i`th pool account, from 1. */
export function poolAccountName(i: number): string {
  return `${POOL_ACCOUNT_PREFIX}${String(i).padStart(2, "0")}`;
}

/** The pool of `size` accounts, in order. */
export function poolAccountNames(size: number): string[] {
  return Array.from({ length: size }, (_, i) => poolAccountName(i + 1));
}

/** Whether a name is one the generated pool hands out (any size), case aside. */
export function isPoolAccountName(name: string): boolean {
  return /^POOL\d{2}$/i.test(name);
}

/**
 * The pool's size as the deployment states it: 0 when the variable is unset
 * or empty, an error naming the variable when it is not a whole number from 0
 * to MAX_POOL_SIZE.
 */
export function poolSizeOf(env: Record<string, string | undefined>): { size: number } | { error: string } {
  const raw = env[POOL_SIZE_ENV]?.trim();
  if (raw === undefined || raw === "") return { size: 0 };
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_POOL_SIZE) {
    return { error: `${POOL_SIZE_ENV}=${JSON.stringify(raw)} is not a pool size: a whole number from 0 to ${MAX_POOL_SIZE}` };
  }
  return { size: Number(raw) };
}

/**
 * The eval pool: `EVAL01` … `EVALnn`, the accounts a party campaign that
 * draws its accounts (`accounts: "evals"`) takes five of per attempt, while
 * every scored or probing attempt plays on a world of its own
 * (infra/world.ts). Sized by the chart's `worlds.pool.size`, created by the
 * bootstrap Job, and never on the long-lived world's allowlist: a world's
 * allowlist is its attempt's accounts, so the pool grows without a restart.
 */
export const EVAL_POOL_SIZE_ENV = "WRATHBENCH_EVAL_POOL_SIZE";
export const EVAL_POOL_ACCOUNT_PREFIX = "EVAL";

export function evalPoolAccountNames(size: number): string[] {
  return Array.from({ length: size }, (_, i) => `${EVAL_POOL_ACCOUNT_PREFIX}${String(i + 1).padStart(2, "0")}`);
}

/** Whether a name is one the eval pool hands out (any size), case aside. */
export function isEvalPoolAccountName(name: string): boolean {
  return /^EVAL\d{2}$/i.test(name);
}

/** The eval pool's size as the deployment states it, as `poolSizeOf`. */
export function evalPoolSizeOf(env: Record<string, string | undefined>): { size: number } | { error: string } {
  const raw = env[EVAL_POOL_SIZE_ENV]?.trim();
  if (raw === undefined || raw === "") return { size: 0 };
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_POOL_SIZE) {
    return { error: `${EVAL_POOL_SIZE_ENV}=${JSON.stringify(raw)} is not a pool size: a whole number from 0 to ${MAX_POOL_SIZE}` };
  }
  return { size: Number(raw) };
}
