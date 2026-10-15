/**
 * The run's session secret is redacted from the moment it is leased.
 *
 * The snippet child holds it in its environment, and a snippet can print its
 * environment; whatever it prints is a `snippet_result` in the trajectory, and
 * from there in the derived store and the published feed. `leaseRunSecret` is
 * the one way a run leases, and it registers the value with the trajectory's
 * redaction in the same step.
 *
 * What the child prints also reaches its own stdout and stderr, and from there
 * the job log and the pod log; the sandbox host scrubs both on the way
 * (`ScrubbedStream`). The CLI drivers' reads of their CLI's transcript are
 * covered in claude-driver.test.ts and codex-driver.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { leaseRunSecret } from "../src/module-auth";
import { REDACTED, SCRUB_HOLD_CHARS, SCRUB_MAX_PENDING_CHARS, ScrubbedStream, SecretRedactor } from "../src/redact";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
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

describe("ScrubbedStream", () => {
  const FAKE_TOKEN = "fake-oauth-token-abcdefghijklmnopqrstuvwxyz";

  function stream(...secrets: string[]): { s: ScrubbedStream; out: () => string } {
    const redactor = new SecretRedactor();
    for (const secret of secrets) redactor.redact(secret);
    let out = "";
    const s = new ScrubbedStream(
      (text) => redactor.scrub(text),
      (text) => {
        out += text;
      },
    );
    return { s, out: () => out };
  }

  test("a secret split across two reads is whole when scrubbed", () => {
    const { s, out } = stream(FAKE_LEASE);
    s.push(`WRATHBENCH_SECRET=${FAKE_LEASE.slice(0, 20)}`);
    // Held until its line ends: the half already read is not written.
    expect(out()).toBe("");
    s.push(`${FAKE_LEASE.slice(20)}\nnext `);
    expect(out()).toBe(`WRATHBENCH_SECRET=${REDACTED}\n`);
  });

  test("a last write with no newline is written, scrubbed, when the stream ends", () => {
    const { s, out } = stream(FAKE_LEASE);
    s.push(`last words ${FAKE_LEASE.slice(0, 9)}`);
    s.push(FAKE_LEASE.slice(9));
    expect(out()).toBe("");
    s.end();
    expect(out()).toBe(`last words ${REDACTED}`);
  });

  test("every registered secret is scrubbed, and text with none passes byte for byte", () => {
    // "short" is under the length floor and never registered.
    const { s, out } = stream(FAKE_LEASE, FAKE_TOKEN, "short");
    const plain = "plain line, é ✓ — a short one\n\n  indented\ttabbed\n";
    s.push(plain);
    expect(out()).toBe(plain);
    s.push(`a ${FAKE_LEASE} b ${FAKE_TOKEN} c ${FAKE_LEASE}\n`);
    s.end();
    expect(out()).toBe(`${plain}a ${REDACTED} b ${REDACTED} c ${REDACTED}\n`);
  });

  test("a line too long to hold is written in part, and a secret at the cut is still caught", () => {
    const { s, out } = stream(FAKE_LEASE);
    const filler = "x".repeat(SCRUB_MAX_PENDING_CHARS);
    s.push(`${filler}${FAKE_LEASE.slice(0, 30)}`);
    // Written all but the held tail, which holds the secret's start.
    expect(out().length).toBe(filler.length + 30 - SCRUB_HOLD_CHARS);
    s.push(`${FAKE_LEASE.slice(30)} end\n`);
    expect(out()).toBe(`${filler}${REDACTED} end\n`);
  });
});

describe("the snippet child's stdout and stderr", () => {
  test("reach the log sink scrubbed of the lease secret; the snippet's own result is unchanged", async () => {
    const dir = tempDir("wrathbench-lease-sbx-");
    const logged = { stdout: "", stderr: "" };
    const host = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      secret: FAKE_LEASE,
      scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
      logSink: (stream, text) => {
        logged[stream] += text;
      },
    });
    try {
      const res = await host.evalSnippet(
        [
          "const s = process.env.WRATHBENCH_SECRET;",
          'console.log("env WRATHBENCH_SECRET=" + s);',
          'console.error("refused with " + s);',
          'console.log("plain line, é ✓");',
          // One line in two writes, apart in time: two reads on the host side.
          'process.stdout.write("split " + s.slice(0, 20));',
          "await sleep(50);",
          'process.stdout.write(s.slice(20) + " done\\n");',
          // No newline: written when the child's stream ends.
          'process.stderr.write("last words " + s);',
        ].join("\n"),
      );
      expect(res.ok).toBe(true);
      // What the model reads is not the log's business: the result keeps what was logged.
      expect(res.logs.map((l) => l.text)).toEqual([`env WRATHBENCH_SECRET=${FAKE_LEASE}`, `refused with ${FAKE_LEASE}`, "plain line, é ✓"]);
    } finally {
      await host.stop();
    }
    expect(logged.stdout).not.toContain(FAKE_LEASE);
    expect(logged.stderr).not.toContain(FAKE_LEASE);
    expect(logged.stdout).toContain(`env WRATHBENCH_SECRET=${REDACTED}\n`);
    expect(logged.stdout).toContain("plain line, é ✓\n");
    expect(logged.stdout).toContain(`split ${REDACTED} done\n`);
    expect(logged.stderr).toContain(`refused with ${REDACTED}\n`);
    expect(logged.stderr).toContain(`last words ${REDACTED}`);
  }, 15_000);
});
