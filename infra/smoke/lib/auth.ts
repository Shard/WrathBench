/**
 * The credential a smoke presents to the module (module/PROTOCOL.md,
 * "Authentication"). Smokes are operator tooling, so they hold the port
 * secret: `WRATHBENCH_MODULE_SECRET`, autoloaded by Bun from `/wrathbench/.env`
 * inside the runner container (docs/RUNBOOK.md, "Secrets"). It goes on
 * every request and every `/events` upgrade as `Authorization: Bearer`, and
 * into `connect({ secret })` for the SDK-driven smokes.
 *
 * Unset, nothing is sent: a pre-auth module accepts that and the hardened one
 * answers `401 unauthorized` on the first call, which is the smoke failing
 * for the right reason.
 */

export const MODULE_SECRET: string | undefined =
  process.env.WRATHBENCH_MODULE_SECRET !== undefined && process.env.WRATHBENCH_MODULE_SECRET !== ""
    ? process.env.WRATHBENCH_MODULE_SECRET
    : undefined;

export function authHeaders(): Record<string, string> {
  return MODULE_SECRET === undefined ? {} : { authorization: `Bearer ${MODULE_SECRET}` };
}
