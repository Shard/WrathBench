/**
 * The run's session secret is redacted from the moment it is leased.
 *
 * The snippet child holds it in its environment, and a snippet can print its
 * environment; whatever it prints is a `snippet_result` in the trajectory, and
 * from there in the derived store and the published feed. `leaseRunSecret` is
 * the one way a run leases, and it registers the value with the trajectory's
 * redaction in the same step.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { leaseRunSecret } from "../src/module-auth";
import { Trajectory } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const FAKE_LEASE = "fake-lease-secret-0123456789abcdef0123456789abcdef";
const FAKE_PORT = "fake-port-secret-for-tests-0123456789abcdef";

function moduleAnswering(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("leaseRunSecret", () => {
  test("a snippet that prints its environment writes [redacted] where the leased secret was", async () => {
    const dir = tempDir("wrathbench-lease-redact-");
    const trajectory = new Trajectory(dir);
    const lease = await leaseRunSecret(
      {
        moduleUrl: "http://module.invalid:8086",
        token: "fake-session-token-0123456789",
        account: "RUNNER",
        env: { WRATHBENCH_MODULE_SECRET: FAKE_PORT },
        fetch: moduleAnswering({ ok: true, secret: FAKE_LEASE, account: "RUNNER" }),
      },
      trajectory,
    );
    expect(lease.secret).toBe(FAKE_LEASE);
    // What `console.log(process.env)` in a snippet comes back as.
    trajectory.append({
      t: "snippet_result",
      ok: true,
      text: `{ WRATHBENCH_SECRET: "${FAKE_LEASE}", WRATHBENCH_ACCOUNT: "RUNNER" }`,
      logs: [`WRATHBENCH_SECRET=${FAKE_LEASE}`],
    });
    trajectory.close();
    const written = readFileSync(join(dir, "trajectory.jsonl"), "utf8");
    expect(written).not.toContain(FAKE_LEASE);
    expect(written).toContain("WRATHBENCH_SECRET: \\\"[redacted]\\\"");
    expect(written).toContain("WRATHBENCH_SECRET=[redacted]");
  });

  test("a lease that yields no secret registers nothing and still launches bare", async () => {
    const registered: (string | undefined)[] = [];
    const sink = { redact: (s: string | undefined) => void registered.push(s) };
    const bare = await leaseRunSecret({ moduleUrl: "http://module.invalid:8086", token: "t", env: {} }, sink);
    expect(bare.secret).toBeUndefined();
    const old = await leaseRunSecret(
      { moduleUrl: "http://module.invalid:8086", token: "t", env: { WRATHBENCH_MODULE_SECRET: FAKE_PORT }, fetch: moduleAnswering({ error: "not_found" }, 404) },
      sink,
    );
    expect(old.secret).toBeUndefined();
    // Trajectory.redact ignores undefined; nothing real was handed over.
    expect(registered).toEqual([undefined, undefined]);
  });

  test("every runner entry point that leases goes through it", () => {
    for (const file of ["run.ts", "mcp.ts"]) {
      const src = readFileSync(resolve(import.meta.dir, "..", "src", file), "utf8");
      expect([file, src.includes("leaseRunSecret(")]).toEqual([file, true]);
      expect([file, /\bleaseSessionSecret\(/.test(src)]).toEqual([file, false]);
    }
  });
});
