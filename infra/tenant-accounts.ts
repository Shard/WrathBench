/**
 * Hosted mode's tenant account pool: `TENANT01` … `TENANTnn`, the accounts a
 * hosted gateway leases to invited people on the shared freeplay world, and
 * never an operator's. One number sizes it, the chart's `hosted.tenants.size`,
 * which reaches the module's allowlist (`wrathbench.moduleAccounts`, with
 * `hosted` on) and the bootstrap Job, as `WRATHBENCH_TENANT_POOL_SIZE`, and
 * nothing else: no pod that parses the fleet config is told it, so no run of
 * the operator's can be drawn onto one.
 *
 * Unlike a harness account, whose password is its name, a tenant account is
 * created with a random password that is never printed or kept. Nobody logs
 * in on it with a client; the module opens its sessions in-process, so the
 * password only has to be one nobody knows. Two digits of pad, as the fleet's
 * pool (runner/src/account-pool.ts), so a pool that grows renames nothing.
 */

/** The env var the bootstrap Job reads the tenant pool's size from. */
export const TENANT_POOL_SIZE_ENV = "WRATHBENCH_TENANT_POOL_SIZE";

/** The prefix every tenant account carries. */
export const TENANT_ACCOUNT_PREFIX = "TENANT";

/** Two digits of pad: the largest tenant pool there is. */
export const MAX_TENANT_POOL_SIZE = 99;

/** The `i`th tenant account, from 1. */
export function tenantAccountName(i: number): string {
  return `${TENANT_ACCOUNT_PREFIX}${String(i).padStart(2, "0")}`;
}

/** The tenant pool of `size` accounts, in order. */
export function tenantAccountNames(size: number): string[] {
  return Array.from({ length: size }, (_, i) => tenantAccountName(i + 1));
}

/** Whether a name is one the tenant pool hands out (any size), case aside. */
export function isTenantAccountName(name: string): boolean {
  return /^TENANT\d{2}$/i.test(name);
}

/**
 * The tenant pool's size as the deployment states it: 0 when the variable is
 * unset or empty, an error naming the variable when it is not a whole number
 * from 0 to MAX_TENANT_POOL_SIZE.
 */
export function tenantPoolSizeOf(env: Record<string, string | undefined>): { size: number } | { error: string } {
  const raw = env[TENANT_POOL_SIZE_ENV]?.trim();
  if (raw === undefined || raw === "") return { size: 0 };
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_TENANT_POOL_SIZE) {
    return { error: `${TENANT_POOL_SIZE_ENV}=${JSON.stringify(raw)} is not a tenant pool size: a whole number from 0 to ${MAX_TENANT_POOL_SIZE}` };
  }
  return { size: Number(raw) };
}
