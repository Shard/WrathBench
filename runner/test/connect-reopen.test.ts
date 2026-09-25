/**
 * The ambient `connect()` against a stand-in module: what it answers, and what
 * the stall detector makes of a stream that was closed and reopened.
 *
 * Earned by a freeplay run whose snippet called `.close()` on every closable
 * binding it could find — including the sandbox's own client. The stream's
 * `close()` disabled the reconnect ladder, and `connect()` answered ok from a
 * latched flag, so the model, the HUD and the state sampler read a frozen cache
 * for fifteen hours. `connect()` now reads the stream, and reopens it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { loadRunConfig } from "../src/config";
import { ContextBuilder } from "../src/loop";
import type { SandboxHost } from "../src/sandbox/host";
import { SandboxHost as RealSandboxHost } from "../src/sandbox/host";
import { Workspace } from "../src/workspace";
import { Trajectory, readTrajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";

/**
 * A stand-in module that serves `/events`, and pushes one `WB_SESSION_STATE` to
 * every socket that subscribes — which is what the real module does on a
 * subscribe to a session already in world (PROTOCOL.md, "/events"), and what
 * makes a reopened stream's state current again.
 */
function startModuleStub(): { url: string; subscribes: () => number; stop(): Promise<void> } {
  let seq = 0;
  let subscribes = 0;
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        return srv.upgrade(req, { data: { token: url.searchParams.get("token") ?? "" } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({
          ok: true,
          token: "t",
          account: "RUNNER",
          character: "Fenwick",
          guid: 7,
          inWorld: true,
        });
      }
      if (url.pathname === "/action") {
        return Response.json({ ok: true, token: "t" });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<{ token: string }>) {
        subscribes++;
        ws.send(
          JSON.stringify({
            seq: seq++,
            opcode: "WB_SESSION_STATE",
            opcodeId: 0xff03,
            ts: Date.now(),
            data: {
              character: "Fenwick",
              guid: "7",
              inWorld: true,
              map: 0,
              x: -6240,
              y: 331,
              z: 383,
              o: 0,
              level: 1 + subscribes,
            },
          }),
        );
      },
      message() {},
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    subscribes: () => subscribes,
    stop: () => server.stop(true),
  };
}

const hosts: SandboxHost[] = [];
const trajectories: Trajectory[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
  for (const t of trajectories.splice(0, trajectories.length)) t.close();
});

function makeHost(moduleUrl: string): SandboxHost {
  const dir = mkdtempSync(join(tmpdir(), "wrathbench-reopen-sbx-"));
  const host = new RealSandboxHost({
    moduleUrl,
    token: "test-token",
    workspace: new Workspace(join(dir, "workspace")),
    snippetTimeoutMs: 20_000,
    pingGraceMs: 2_000,
  });
  hosts.push(host);
  return host;
}

/** `observation.connected` as the child reports it — the field the sampler reads. */
async function connected(host: SandboxHost): Promise<unknown> {
  const snap = await host.stateSnapshot();
  return (snap["observation"] as { connected?: unknown } | undefined)?.connected;
}

describe("the ambient connect() reads the stream, not a flag", () => {
  test("a snippet that closed the stream can reopen it, and observation resumes", async () => {
    const stub = startModuleStub();
    const host = makeHost(stub.url);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    expect(await connected(host)).toBe(true);
    const first = (await host.stateSnapshot())["eventCount"] as number;
    expect(first).toBeGreaterThan(0);

    // The cleanup loop's move, reduced to its one consequential call.
    await host.evalSnippet("events.close(); 'closed'");
    expect(await connected(host)).toBe(false);

    // The old answer was "ok" over a dead socket. The honest one is a reopen.
    const back = await host.evalSnippet("await connect(); return events.connected;");
    expect(back.ok).toBe(true);
    expect(back.value).toBe("true");
    expect(await connected(host)).toBe(true);
    expect(stub.subscribes()).toBe(2);

    // Observation is arriving again: the module's reattach state folded into the
    // cache, so `state` is current rather than fifteen hours stale.
    const snap = await host.stateSnapshot();
    expect(snap["eventCount"] as number).toBeGreaterThan(first);
    expect((snap["self"] as { level?: { value?: unknown } }).level?.value).toBe(3);

    // And it stays cheap while the stream is open: no third subscribe.
    await host.evalSnippet("await connect(); await connect();");
    expect(stub.subscribes()).toBe(2);
    await stub.stop();
  });

  test(
    "a subscribe the module refuses is reported, not answered ok",
    async () => {
      // A token the module has no session for is refused before the handshake
      // (PROTOCOL.md, "/events"), so there is nothing to reopen and nothing to
      // re-create here: the snippet is told, and the words are the stream's.
      const refusing = Bun.serve({ port: 0, fetch: () => new Response("no session", { status: 404 }) });
      const host = makeHost(`http://127.0.0.1:${refusing.port}`);
      const res = await host.evalSnippet("await connect(); return 'connected';");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("failed to connect");
      expect(await connected(host)).toBe(false);
      await refusing.stop(true);
    },
    30_000,
  );
});

describe("the stall detector sees the reopen", () => {
  test("close -> three stalled samples -> connect() is recorded as a resume", async () => {
    const stub = startModuleStub();
    const host = makeHost(stub.url);
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");

    const dir = mkdtempSync(join(tmpdir(), "wrathbench-reopen-loop-"));
    let clock = 1_000_000;
    const config = {
      ...loadRunConfig({ driver: "stub", stateIntervalMs: 60_000 }),
      runId: "run-reopen",
      token: "test-token",
    };
    const trajectory = new Trajectory(dir);
    trajectories.push(trajectory);
    trajectory.writeMeta({ runId: "run-reopen", harnessVersion: "t", startedAt: 1, config });
    const ctx = new ContextBuilder({
      config,
      sandbox: host,
      workspace: new Workspace(join(dir, "workspace")),
      trajectory,
      watchdogs: new Watchdogs(config.watchdogs),
      now: () => clock,
    });
    const sample = async (): Promise<void> => {
      clock += 60_000;
      await ctx.sampleState();
    };
    const records = (kind: string): Record<string, unknown>[] =>
      readTrajectory(dir).filter((r) => r.t === "harness" && r["kind"] === kind);

    // One sample arms the detector: something has been observed.
    await sample();
    await host.evalSnippet("events.close(); 'closed'");
    for (let i = 0; i < 3; i++) await sample();
    expect(records("observation_stalled")).toHaveLength(1);

    // The reopen: the module's reattach event moves the cursor, and the next
    // sample says the observation came back rather than stalling forever.
    await host.evalSnippet("await connect(); events.connected");
    await sample();
    expect(records("observation_resumed")).toHaveLength(1);
    expect(records("observation_stalled")).toHaveLength(1);
    await stub.stop();
  });
});
