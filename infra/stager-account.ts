/**
 * The party stager's SOAP account (docs/proposals/GROUP-PLAY.md §2, §3).
 *
 * Idempotently ensures STAGER exists with the given password and full GM
 * (gmlevel 3, SEC_ADMINISTRATOR, which `ACSoap.cpp` requires before it runs
 * any command). It is the credential `infra/fixtures/stage-party.ts` presents
 * to SOAP to `.additem` a member's gear, and nothing else uses it:
 *
 *   - it is NOT on the module's account allowlist (`worldserver.accounts`),
 *     so no bench session can be opened on it;
 *   - its password lives in the env Secret under WRATHBENCH_STAGER_PASSWORD,
 *     which the chart passes to the fleet and runner pods only, and the run-pod
 *     env builder refuses outright (infra/run-pod.ts);
 *   - SOAP itself is reachable only in-cluster from those two pods' labels.
 *
 * The same password goes into the Secret (SOPS, in the cluster repo) and in
 * here, on stdin, never argv:
 *
 *   read -rs P && printf '%s\n' "$P" | bun wb accounts stager
 *
 * which is `bun infra/stager-account.ts --password-stdin` in the runner pod.
 * Without the flag the password is WRATHBENCH_STAGER_PASSWORD in this
 * process's environment — in the runner pod with staging on, that is the
 * Secret's own value, so `bun infra/stager-account.ts` alone there makes the
 * account match the Secret. Re-run with a new password to rotate it, then
 * update the Secret and restart the fleet and runner pods.
 */

import { runGmAccountCli } from "./gm-account.ts";
import { STAGER_ACCOUNT, STAGER_PASSWORD_ENV } from "./fixtures/soap.ts";

if (import.meta.main) {
  await runGmAccountCli(
    {
      account: STAGER_ACCOUNT,
      passwordEnv: STAGER_PASSWORD_ENV,
      comment: "wrathbench party stager (SOAP only)",
      script: "infra/stager-account.ts",
      tag: "stager",
    },
    Bun.argv.slice(2),
  );
}
