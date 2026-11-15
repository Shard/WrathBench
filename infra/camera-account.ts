/**
 * The camera's GM account.
 *
 * Idempotently ensures the CAMERA account exists with the given password and
 * full GM (gmlevel 3 on every realm), for the unattended camera client
 * (docs/RUNBOOK.md, "Camera"). The work is `infra/gm-account.ts`, shared with
 * the spectator's and the stager's accounts.
 *
 * Operator tooling, outside the agent path. The account is never on a
 * module allowlist: the camera only logs in over the game socket, inside a
 * world's pod, invisible from the moment it loads (the worlds' GM.LoginState
 * and GM.Visible, which the chart's camera block sets).
 *
 * The same password goes under `camera.passwordKey` in the chart's env
 * Secret, which the camera client reads by name. There is no default, and it
 * is never on a command line:
 *
 *   read -rs P && printf '%s\n' "$P" | bun wb accounts camera
 *
 * which is `bun infra/camera-account.ts --password-stdin` in the runner pod.
 * Without the flag the password is WRATHBENCH_CAMERA_PASSWORD in this
 * process's environment.
 *
 * Re-run with a new password to rotate it (and the Secret with it).
 */

import { runGmAccountCli } from "./gm-account.ts";

if (import.meta.main) {
  await runGmAccountCli(
    {
      account: "CAMERA",
      passwordEnv: "WRATHBENCH_CAMERA_PASSWORD",
      comment: "wrathbench unattended camera",
      script: "infra/camera-account.ts",
      tag: "camera",
    },
    Bun.argv.slice(2),
  );
}
