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
 * (`ScrubbedStream`). And it reaches the model: every tool result is scrubbed
 * with the trajectory's list before any driver logs or sends it (`callTool`),
 * here against a real child; that each driver sends the scrubbed text, and
 * scrubs the turn's context message too, is covered in loop.test.ts,
 * claude-driver.test.ts and codex-driver.test.ts, beside the CLI drivers'
 * reads of their CLI's transcript.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EpisodicLog } from "../src/episodic";
import { leaseRunSecret } from "../src/module-auth";
import { REDACTED, SCRUB_HOLD_CHARS, SCRUB_MAX_PENDING_CHARS, ScrubbedStream, SecretRedactor } from "../src/redact";
import { ReflectGate } from "../src/reflect";
import { SandboxHost, type SnippetResult } from "../src/sandbox/host";
import type { ActionHintNote } from "../src/sandbox/ipc";
import { Scratchpad } from "../src/scratchpad";
import { appendPendingActionHints, callTool, type ToolContext } from "../src/tools";
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
      // The host's result keeps what was logged: the tool result built from it
      // is scrubbed for the model (`callTool`, below), not this.
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

/** A tool context over `sandbox`, scrubbing with `secrets`. */
function toolContext(dir: string, sandbox: SandboxHost, scratchpad: Scratchpad, secrets: ToolContext["secrets"]): ToolContext {
  return {
    sandbox,
    scratchpad,
    sessionLive: () => true,
    reflect: new ReflectGate(),
    episodic: new EpisodicLog(join(dir, "episodic.jsonl")),
    turn: () => 1,
    secrets,
  };
}

describe("a tool result the model reads, from a real snippet child", () => {
  function setup(): { ctx: ToolContext; host: SandboxHost; scratchpad: Scratchpad; trajectory: Trajectory } {
    const dir = tempDir("wrathbench-lease-tool-");
    const trajectory = new Trajectory(dir);
    trajectory.redact(FAKE_LEASE);
    const scratchpad = new Scratchpad(join(dir, "scratchpad.md"));
    const host = new SandboxHost({
      moduleUrl: "http://worldserver:8086",
      token: "test-token",
      secret: FAKE_LEASE,
      scratchpad,
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
      logSink: () => {},
    });
    return { ctx: toolContext(dir, host, scratchpad, trajectory), host, scratchpad, trajectory };
  }

  test("the secret a snippet logs, returns or throws is [redacted]", async () => {
    const { ctx, host, trajectory } = setup();
    try {
      const logged = await callTool(ctx, "run_snippet", {
        code: 'console.log("env " + process.env.WRATHBENCH_SECRET); console.error("refused with " + process.env.WRATHBENCH_SECRET); console.log("plain line, é ✓")',
      });
      expect(logged.text).toContain(`--- console ---\n[log] env ${REDACTED}\n[error] refused with ${REDACTED}\n[log] plain line, é ✓`);
      const returned = await callTool(ctx, "run_snippet", { code: "process.env.WRATHBENCH_SECRET" });
      expect(returned.text).toContain(`=> "${REDACTED}"`);
      const thrown = await callTool(ctx, "run_snippet", { code: 'throw new Error("refused with " + process.env.WRATHBENCH_SECRET)' });
      expect(thrown.isError).toBe(true);
      expect(thrown.text).toContain(`Error: refused with ${REDACTED}`);
      for (const r of [logged, returned, thrown]) expect(r.text).not.toContain(FAKE_LEASE);
    } finally {
      await host.stop();
      trajectory.close();
    }
  }, 15_000);

  test("a secret written to stderr in two pieces is [redacted] in the crash notice, and the notice's cut leaves no piece of it", async () => {
    const { ctx, host, trajectory } = setup();
    // The notice quotes the last 600 characters of stderr. Raw, this tail
    // would start inside the secret; scrubbed first, it holds the marker whole.
    const filler = 570;
    expect(("dumping ".length + FAKE_LEASE.length + filler) - 600).toBeGreaterThan("dumping ".length);
    try {
      const res = await callTool(ctx, "run_snippet", {
        code: [
          "const s = process.env.WRATHBENCH_SECRET;",
          'process.stderr.write("dumping " + s.slice(0, 20));',
          "await sleep(50);",
          `process.stderr.write(s.slice(20) + "x".repeat(${filler}) + "\\n");`,
          "await sleep(20);",
          "process.exit(9);",
        ].join("\n"),
      });
      expect(res.isError).toBe(true);
      const crash = host.drainNotices().find((n) => n.kind === "sandbox_restarted");
      expect(crash?.text).toContain(`Last stderr: dumping ${REDACTED}${"x".repeat(filler)}`);
      for (let cut = 0; cut + MIN_PIECE <= FAKE_LEASE.length; cut++) {
        expect(crash?.text).not.toContain(FAKE_LEASE.slice(cut, cut + MIN_PIECE));
      }
    } finally {
      await host.stop();
      trajectory.close();
    }
  }, 15_000);

  test("a secret a snippet writes to the scratchpad is stored [redacted], so the pad the model is shown is the pad it can edit", async () => {
    const { ctx, host, scratchpad, trajectory } = setup();
    try {
      await callTool(ctx, "run_snippet", { code: 'await scratchpad.write("# plan\\nkey: " + process.env.WRATHBENCH_SECRET)' });
      await callTool(ctx, "run_snippet", { code: 'await scratchpad.append("again " + process.env.WRATHBENCH_SECRET)' });
      expect(scratchpad.read()).toBe(`# plan\nkey: ${REDACTED}\nagain ${REDACTED}`);
      const edited = await callTool(ctx, "edit_scratchpad", { old: `key: ${REDACTED}`, new: "key: held by the SDK" });
      expect(edited.isError).toBeFalsy();
      expect(scratchpad.read()).toBe(`# plan\nkey: held by the SDK\nagain ${REDACTED}`);
    } finally {
      await host.stop();
      trajectory.close();
    }
  }, 15_000);
});

/** Shorter pieces than this could match ordinary text; longer ones are the secret. */
const MIN_PIECE = 12;

describe("the tool-result scrub", () => {
  function fake(result: SnippetResult, pending: ActionHintNote[]): SandboxHost {
    return {
      evalSnippet: () => Promise.resolve(result),
      drainActionHints: () => Promise.resolve(pending.splice(0)),
    } as unknown as SandboxHost;
  }

  test("text with no secret in it comes through byte for byte", async () => {
    const dir = tempDir("wrathbench-lease-plain-");
    const plain: SnippetResult = {
      ok: true,
      value: '"a literal [redacted] is text like any other, é ✓  "',
      logs: [{ level: "log", ts: 1, text: "tab\tand trailing spaces  \n\n" }],
      durationMs: 3,
    };
    const registry = new SecretRedactor();
    registry.redact(FAKE_LEASE);
    const pad = new Scratchpad(join(dir, "scratchpad.md"));
    const withSecret = await callTool(toolContext(dir, fake(plain, []), pad, registry), "run_snippet", { code: "x" });
    const without = await callTool(toolContext(dir, fake(plain, []), pad, new SecretRedactor()), "run_snippet", { code: "x" });
    expect(withSecret.text).toBe(without.text);
    expect(withSecret.text).toBe('ok (3ms)\n=> "a literal [redacted] is text like any other, é ✓  "\n--- console ---\n[log] tab\tand trailing spaces  \n\n');
  });

  test("a pending hint carrying the secret is scrubbed on a non-snippet result and on a refused call", async () => {
    const dir = tempDir("wrathbench-lease-hint-");
    const hint = (): ActionHintNote => ({ action: "say", status: "refused", count: 1, hint: `echoed ${FAKE_LEASE}`, ts: 1 });
    const pending: ActionHintNote[] = [hint()];
    const registry = new SecretRedactor();
    registry.redact(FAKE_LEASE);
    const ctx = toolContext(dir, fake({ ok: true, logs: [], durationMs: 1 }, pending), new Scratchpad(join(dir, "scratchpad.md")), registry);
    const written = await callTool(ctx, "write_scratchpad", { content: "# hi" });
    expect(written.text).toBe(`written (4 chars)\n--- harness ---\nsay refused: echoed ${REDACTED}`);
    pending.push(hint());
    const refused = await appendPendingActionHints(ctx, { text: "tool arguments were not valid JSON", isError: true });
    expect(refused).toEqual({ text: `tool arguments were not valid JSON\n--- harness ---\nsay refused: echoed ${REDACTED}`, isError: true });
  });
});
