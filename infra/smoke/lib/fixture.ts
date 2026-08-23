/**
 * The fixture boot a smoke does before it starts proving anything: find out
 * whether its persistent character exists, create it through the module if it
 * does not, and hand the character to `infra/fixtures/apply.ts` to be placed
 * into a named scenario (docs/FOLLOW-UPS.md item 45, infra/README.md
 * "Scenario fixtures").
 *
 * Shared by `travel.ts --from tram-ironforge` (SDK client) and
 * `kill-credit.ts` (raw HTTP/WS), which is why nothing here knows about
 * either: the caller injects its own logger, its own failure constructor, and
 * its own "create this character and log straight back out" step. The retry
 * budget is a parameter too, deliberately — travel is a long probe and can
 * wait twenty minutes for a contended account, while the preflight gate runs
 * every tick and a slow failure there is the expensive kind (ADR-0023).
 *
 * Operator tooling. `apply.ts` writes the characters DB directly and refuses
 * any account outside the SMOKE/PROBE pattern; nothing in `runner/` or `sdk/`
 * imports this file.
 */

/** Repo root as a smoke sees it: the fixtures tool is spawned from there. */
export const REPO_ROOT = `${import.meta.dir}/../../..`;

export type FixtureContext = {
  /** Module base URL, e.g. `http://worldserver:8086`. */
  base: string;
  account: string;
  character: string;
  /** Token prefix for the utility `POST /characters` sessions; must yield >= 32 chars. */
  token: string;
  log: (msg: string) => void;
  /** The caller's failure path: throws, exits, whatever its reporting needs. */
  fail: (msg: string) => never;
  /** Create `character` through the module (CMSG_CHAR_CREATE) and log out again. */
  createAndLogout: () => Promise<void>;
  /** How long a contended account may be waited out. Default 20 minutes. */
  contendedDeadlineMs?: number;
  /** Gap between those retries. Default 60s. */
  contendedRetryMs?: number;
};

/**
 * How `infra/fixtures/apply.ts` is invoked. It talks to the characters DB
 * directly, and the DB port is not published to the host:
 *   - WRATHBENCH_FIXTURES_CMD, if set, is the command verbatim (space-split),
 *     with --account/--character/--scenario appended;
 *   - else, with WRATHBENCH_DB_HOST set (inside a container on the compose
 *     network), run it in-process with bun;
 *   - else, from the host, through compose. The `fixtures` service carries
 *     the DB env and an `entrypoint` of `bun run infra/fixtures/apply.ts`, so
 *     only the flags are passed here — apply.ts rejects positional arguments.
 *     `--no-deps` is load-bearing: without it compose may decide a dependency
 *     is stale and recreate the worldserver underneath live episodes (see
 *     infra/README.md and the fleet service comment in compose.yml).
 */
export function fixturesCmd(): string[] {
  const explicit = process.env.WRATHBENCH_FIXTURES_CMD;
  if (explicit) return explicit.split(" ").filter(Boolean);
  if (process.env.WRATHBENCH_DB_HOST) return ["bun", "infra/fixtures/apply.ts"];
  return ["docker", "compose", "-f", "infra/compose.yml", "run", "--rm", "--no-deps", "fixtures"];
}

/**
 * The character names this account holds right now, via POST /characters.
 * Its parked utility session contends for the account exactly as a real one
 * does, so `account_in_use` (another probe holds the account) and the module's
 * own `504 timeout` are waited out on the caller's budget — this is the
 * fixture path's first module call, and a contended account must cost a wait,
 * not a bare failure.
 */
export async function characterNames(ctx: FixtureContext): Promise<string[]> {
  const retryMs = ctx.contendedRetryMs ?? 60_000;
  const deadline = Date.now() + (ctx.contendedDeadlineMs ?? 20 * 60_000);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ctx.base}/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A fresh token per attempt: a reused one can still be held by the
      // parked session the previous attempt timed out on.
      body: JSON.stringify({ token: `${ctx.token}-list${attempt}`, account: ctx.account }),
    });
    const json = (await res.json().catch(() => undefined)) as
      | { ok?: boolean; error?: string; enum?: { characters?: { name: string }[] } }
      | undefined;
    if (res.ok && json?.ok) return (json.enum?.characters ?? []).map((c) => c.name);
    const transient = json?.error === "account_in_use" || json?.error === "timeout" || res.status === 504;
    if (!transient || Date.now() > deadline) {
      ctx.fail(`POST /characters on ${ctx.account} failed: ${res.status} ${JSON.stringify(json)}`);
    }
    ctx.log(`  /characters says ${json?.error ?? res.status}; retrying in ${Math.round(retryMs / 1000)}s`);
    await Bun.sleep(retryMs);
  }
}

/**
 * The fixture tool writes a *logged-out* character's rows and exits non-zero
 * if the character does not exist — creating one is the module's job, through
 * the same CMSG_CHAR_CREATE path a client uses. So: enumerate, and only if the
 * name is absent create it with a session and log straight back out.
 */
export async function ensureFixtureCharacter(ctx: FixtureContext): Promise<void> {
  const names = await characterNames(ctx);
  ctx.log(`  ${ctx.account} holds: ${names.join(", ") || "(no characters)"}`);
  if (names.some((n) => n.toLowerCase() === ctx.character.toLowerCase())) return;
  ctx.log(`  ${ctx.character} does not exist yet: creating it through the module`);
  await ctx.createAndLogout();
  ctx.log(`  ${ctx.character} created and logged out`);
}

/** Place the fixture character for `scenario`. apply.ts waits for online=0 itself. */
export async function applyScenario(ctx: FixtureContext, scenario: string): Promise<void> {
  const argv = [...fixturesCmd(), "--account", ctx.account, "--character", ctx.character, "--scenario", scenario];
  ctx.log(`fixture: ${argv.join(" ")}`);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit", env: process.env });
  } catch (e) {
    ctx.fail(
      `could not run the fixtures tool (${argv[0]}): ${String(e instanceof Error ? e.message : e)} — ` +
        `set WRATHBENCH_FIXTURES_CMD to the exact command for this environment, or WRATHBENCH_DB_HOST=db ` +
        `to run \`bun infra/fixtures/apply.ts\` directly from inside the compose network`,
    );
  }
  const code = await proc.exited;
  if (code !== 0) {
    ctx.fail(`fixtures apply --scenario ${scenario} exited ${code}; the smoke cannot start from a scenario it could not place`);
  }
  ctx.log(`  scenario ${scenario} applied to ${ctx.character}`);
}
