/**
 * Operator spectator account.
 *
 * Idempotently ensures the SPECTATOR account exists with the given password
 * and full GM (gmlevel 3 on every realm), for operator inspection of the
 * world. The work is `infra/gm-account.ts`, shared with the stager's account.
 *
 * This is operator tooling, outside the agent path: the observation/action
 * contracts in wrath-mcp/docs/CONTRACTS.md bind the benchmark agent, not the human at
 * the keyboard. The account is deliberately not created by bootstrap.ts —
 * the harness accounts never carry GM, and this one never runs unattended.
 *
 * There is no default password, and it is never on a command line, where the
 * process list would show it. From a checkout it goes to the runner on stdin
 * (`printf` is a shell builtin, so it is not a process either):
 *
 *   read -rs P && printf '%s\n' "$P" | bun wb accounts spectator
 *
 * which is `bun infra/spectator-account.ts --password-stdin` in the runner pod
 * (`bun wb --local …` on the quickstart): `kubectl exec` carries no
 * environment, so stdin is the one way in. Without the flag the password is
 * WRATHBENCH_SPECTATOR_PASSWORD in this process's environment.
 *
 * Re-run with a new password to rotate it.
 */

import { runGmAccountCli } from "./gm-account.ts";

if (import.meta.main) {
  await runGmAccountCli(
    {
      account: "SPECTATOR",
      passwordEnv: "WRATHBENCH_SPECTATOR_PASSWORD",
      comment: "wrathbench operator spectator",
      script: "infra/spectator-account.ts",
      tag: "spectator",
    },
    Bun.argv.slice(2),
  );
}
