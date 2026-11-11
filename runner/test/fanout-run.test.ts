/**
 * A fan-out run (`runner/src/fanout-run.ts`): the grant as run configuration,
 * the tool list a fan-out run is served, and, with the real confined child
 * (the benchmark's extension on every seat) against a stub of the module, a
 * record per character in `sessions/<Character>/`, the roster file, the turn
 * context, and what a pause leaves for the resume.
 *
 * The stub speaks the routes a seat uses (wrath-mcp/module/PROTOCOL.md:
 * `/lease`, `/session`, `/action`, `/events`), keyed by token. Names are
 * invented.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { SessionReader, validateSession, type CallRow } from "@wrathbench/mcp/record";
import { Scratchpad } from "@wrathbench/mcp/scratchpad";
import { fanoutConfigSchema, loadRunConfig } from "../src/config";
import { fanoutSessionNote, knownCharacters, openFanout, readRoster, ROSTER_FILE } from "../src/fanout-run";
import { ContextBuilder } from "../src/loop";
import { EpisodicLog } from "../src/episodic";
import { ClosedWindowReflectGate } from "../src/reflect";
import { configFromArgs, fanoutFromArgs } from "../src/run";
import { RunArgsError } from "../src/run-flags";
import { SandboxHost } from "../src/sandbox/host";
import { characterSessionDir, characterSessionDirs, RecordSignals, removeSessionRing, SESSION_DIR, SESSIONS_DIR } from "../src/session-record";
import { callTool, TOOLS, toolsFor, type ToolContext } from "../src/tools";
import { Trajectory } from "../src/trajectory";
import { Watchdogs } from "../src/watchdogs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const PORT_SECRET = "stub-port-secret-0123456789abcdef0123456789abcdef";

interface Stub {
  url: string;
  sessions: Map<string, { account: string; character: string; guid: string }>;
  stop(): Promise<void>;
}

/** The module, as far as a seat needs it: a lease per token, one session per account, each token its own stream. */
function startStub(): Stub {
  const sockets = new Map<string, Set<ServerWebSocket<{ token: string }>>>();
  const leases = new Map<string, { secret: string; account: string }>();
  const sessions = new Map<string, { account: string; character: string; guid: string }>();
  const guids = new Map<string, string>();
  const seqs = new Map<string, number>();
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const send = (token: string, opcode: string, data: unknown): void => {
    const seq = seqs.get(token) ?? 0;
    seqs.set(token, seq + 1);
    for (const ws of sockets.get(token) ?? []) ws.send(JSON.stringify({ seq, opcode, opcodeId: 0, ts: Date.now(), data }));
  };
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (url.pathname === "/events") {
        const token = url.searchParams.get("token") ?? "";
        if (bearer !== PORT_SECRET && leases.get(token)?.secret !== bearer) return json({ ok: false, error: "unauthorized" }, 401);
        return srv.upgrade(req, { data: { token } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return json({ ok: true, module: "mod-wrathbench", protocol: 1, build: "stub" });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const token = String(body["token"] ?? "");
      if (bearer !== PORT_SECRET && leases.get(token)?.secret !== bearer) return json({ ok: false, error: "unauthorized" }, 401);
      if (url.pathname === "/lease" && req.method === "POST") {
        const secret = `${leases.size + 1}`.padStart(8, "0").padEnd(64, "e");
        leases.set(token, { secret, account: String(body["account"]) });
        return json({ ok: true, token, account: body["account"], secret, allowGm: false });
      }
      if (url.pathname === "/lease") return json({ ok: true, token, released: leases.delete(token) });
      if (url.pathname === "/session" && req.method === "POST") {
        const raw = String(body["character"] ?? "");
        const character = raw.slice(0, 1).toUpperCase() + raw.slice(1).toLowerCase();
        const account = leases.get(token)?.account ?? "RUNNER";
        if (!guids.has(character)) guids.set(character, String(301 + guids.size));
        const guid = guids.get(character)!;
        const fresh = sessions.get(token)?.character !== character;
        sessions.set(token, { account, character, guid });
        if (fresh) {
          setTimeout(() => {
            send(token, "SMSG_UPDATE_OBJECT", {
              blocks: 1,
              objects: [{ update: "create", guid, objectType: "player", self: true, moveFlags: 0, runSpeed: 7, pos: { x: -8900 + sessions.size, y: -120, z: 82, o: 1 }, fields: { entry: 0, health: 80, maxHealth: 100, level: 3, powerType: 0, power1: 40, maxPower1: 90, playerFlags: 0, unitFlags: 0, race: 1, class: 1 } }],
            });
          }, 5);
        }
        return json({ ok: true, account, character, guid, inWorld: true });
      }
      if (url.pathname === "/session") return sessions.delete(token) ? json({ ok: true }) : json({ ok: false, error: "no_session" }, 404);
      if (url.pathname === "/action") return json({ ok: true, action: body["action"] });
      return json({ ok: false, error: "not_found" }, 404);
    },
    websocket: {
      open(ws) {
        const set = sockets.get(ws.data.token) ?? new Set();
        sockets.set(ws.data.token, set);
        set.add(ws);
        const s = sessions.get(ws.data.token);
        if (s !== undefined) setTimeout(() => send(ws.data.token, "WB_SESSION_STATE", { character: s.character, guid: s.guid, inWorld: true, map: 0, x: -8900, y: -120, z: 82, o: 1, level: 3 }), 5);
      },
      message() {},
      close(ws) {
        sockets.get(ws.data.token)?.delete(ws);
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, sessions, stop: async () => void (await server.stop(true)) };
}

describe("the grant as run configuration", () => {
  test("--max-characters above 1 with --accounts is a fan-out run; absent or 1 is a run with no fanout at all", () => {
    expect(fanoutFromArgs({})).toBeUndefined();
    expect(fanoutFromArgs({ "max-characters": "1" })).toBeUndefined();
    expect(fanoutFromArgs({ "max-characters": "3", accounts: "POOL01, POOL02,POOL03" })).toEqual({ characters: 3, accounts: ["POOL01", "POOL02", "POOL03"] });
    expect(() => fanoutFromArgs({ accounts: "POOL01,POOL02" })).toThrow(RunArgsError);
    expect(() => fanoutFromArgs({ "max-characters": "two", accounts: "POOL01,POOL02" })).toThrow(RunArgsError);

    const single = configFromArgs(["--driver", "stub", "--stub", "x.json"]);
    expect("fanout" in single).toBe(false);
    const fan = configFromArgs(["--driver", "stub", "--stub", "x.json", "--max-characters", "2", "--accounts", "POOL01,POOL02"]);
    expect(fan.fanout).toEqual({ characters: 2, accounts: ["POOL01", "POOL02"] });
    // The run's account still answers: the first of its accounts.
    expect(fan.account).toBe("POOL01");
  });

  test("a grant needs an account per character, each once, and stages only on its own accounts", () => {
    const issues = (v: unknown): string => fanoutConfigSchema.safeParse(v).error?.issues.map((i) => i.message).join("; ") ?? "";
    expect(issues({ characters: 2, accounts: ["POOL01", "POOL02"] })).toBe("");
    expect(issues({ characters: 3, accounts: ["POOL01", "POOL02"] })).toContain("3 characters at once need 3 accounts");
    expect(issues({ characters: 2, accounts: ["POOL01", "pool01"] })).toContain("listed twice");
    expect(issues({ characters: 2, accounts: ["POOL01", "POOL02"], staged: [{ character: "Alfa", account: "POOL09" }] })).toContain("not one of this run's accounts");
    expect(issues({ characters: 41, accounts: Array.from({ length: 41 }, (_, i) => `ACC${i}`) })).not.toBe("");
  });

  test("never a scored episode, a party member or a continuation", () => {
    const fanout = { characters: 2, accounts: ["POOL01", "POOL02"] };
    expect(() => loadRunConfig({ driver: "stub", fanout, episode: "e90" })).toThrow("scored single-character episode");
    expect(() => loadRunConfig({ driver: "stub", fanout, episode: "freeplay", continuedFrom: "run-1" })).toThrow("--continue-from");
    expect(loadRunConfig({ driver: "stub", fanout, episode: "freeplay" }).fanout).toEqual(fanout);
    expect(loadRunConfig({ driver: "stub", fanout }).fanout).toEqual(fanout);
  });

  test("staged characters are known from the launch, each with a token of its own; a resume reads the roster it wrote", () => {
    let n = 0;
    const staged = knownCharacters({ characters: 2, accounts: ["POOL01", "POOL02"], staged: [{ character: "Alfa", account: "POOL01" }, { character: "Bravo", account: "POOL02" }] }, [], () => `token-${++n}`);
    expect(staged).toEqual([
      { character: "Alfa", account: "POOL01", token: "token-1", in: false },
      { character: "Bravo", account: "POOL02", token: "token-2", in: false },
    ]);
    const stored = [{ character: "Alfa", account: "POOL01", token: "kept", in: true }];
    expect(knownCharacters({ characters: 2, accounts: ["POOL01", "POOL02"] }, stored)).toEqual(stored);
  });

  test("the launch note states the grant and the tools, and names what was staged or brought back", () => {
    const fresh = fanoutSessionNote({ characters: 5, staged: ["Alfa", "Bravo"], resumed: false, back: [], lost: [] });
    expect(fresh).toStartWith("This run may have up to 5 characters in the world at once. login_character logs one in by name");
    expect(fresh).toContain("These characters already exist and are yours: Alfa, Bravo.");
    const resumed = fanoutSessionNote({ characters: 5, staged: ["Alfa"], resumed: true, back: ["Alfa"], lost: [{ character: "Bravo", error: "timeout" }] });
    expect(resumed).toStartWith("the runner process was restarted and this run resumed after a pause.");
    expect(resumed).toContain("have been logged back in: Alfa.");
    expect(resumed).toContain("could not be logged back in: Bravo (timeout).");
    expect(resumed).not.toContain("already exist");
  });
});

describe("the tools a fan-out run is served", () => {
  test("the nine in their places, `character` on three of them, and the three roster tools after", () => {
    const fan = toolsFor({ fanout: true });
    expect(fan.map((t) => t.name)).toEqual([
      "run_snippet",
      "recent_events",
      "state_summary",
      "search_reference",
      "write_scratchpad",
      "edit_scratchpad",
      "reflect",
      "log_status",
      "read_log",
      "login_character",
      "logout_character",
      "list_characters",
    ]);
    for (const name of ["run_snippet", "recent_events", "state_summary"]) {
      expect(Object.keys(fan.find((t) => t.name === name)!.inputSchema["properties"] as object)).toContain("character");
    }
    // The benchmark's own are the very definitions a single-character run is served.
    for (const name of ["search_reference", "write_scratchpad", "edit_scratchpad", "reflect", "log_status", "read_log"]) {
      expect(fan.find((t) => t.name === name)).toEqual(TOOLS.find((t) => t.name === name)!);
    }
    expect(toolsFor({ fanout: true, wikiSearch: false }).map((t) => t.name)).not.toContain("search_reference");
    // A run that drives one character is served exactly what it was.
    expect(toolsFor({})).toBe(TOOLS);
    expect(toolsFor({ sandbox: {} })).toBe(TOOLS);
  });
});

describe("a fan-out run, end to end", () => {
  const stops: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
  });

  function rig(runId: string, o: { runsDir?: string } = {}) {
    const stub = startStub();
    stops.push(() => stub.stop());
    const runsDir = o.runsDir ?? tempDir("wrathbench-fanout-runs-");
    const runDir = join(runsDir, runId);
    const config = { ...loadRunConfig({ driver: "stub", moduleUrl: stub.url, runsDir, stateIntervalMs: 1, fanout: { characters: 3, accounts: ["POOL01", "POOL02", "POOL03"] } }), runId, token: "f".repeat(32) };
    const trajectory = new Trajectory(runDir);
    trajectory.writeMeta({ runId, harnessVersion: "t", startedAt: 1, config });
    const scratchpad = new Scratchpad(join(runDir, "scratchpad.md"));
    const signals = new RecordSignals();
    const sandbox = new SandboxHost({
      moduleUrl: stub.url,
      token: config.token,
      scratchpad,
      snippetTimeoutMs: 5_000,
      pingGraceMs: 1_000,
      fanout: { maxCharacters: 3 },
      signals,
      recordTickMs: 3_600_000,
      logSink: () => {},
    });
    stops.push(() => sandbox.stop());
    const roster = openFanout({ fanout: config.fanout!, moduleUrl: stub.url, runDir, runsDir, sandbox, secrets: trajectory, signals, env: { WRATHBENCH_MODULE_SECRET: PORT_SECRET } });
    const ctx: ToolContext = {
      sandbox,
      scratchpad,
      sessionLive: () => true,
      turn: () => 1,
      secrets: trajectory,
      reflect: new ClosedWindowReflectGate(),
      episodic: new EpisodicLog(join(runDir, "episodic.jsonl")),
      ...(sandbox.callRecord !== undefined ? { record: sandbox.callRecord } : {}),
    };
    return { stub, runsDir, runDir, config, trajectory, scratchpad, sandbox, roster, ctx, call: (name: string, args: unknown) => callTool(ctx, name, args) };
  }

  test("a record per character in sessions/<Character>/, the roster 0600, no token anywhere a reader looks", async () => {
    const r = rig("fan-1");
    expect(toolsFor(r.ctx).map((t) => t.name)).toContain("login_character");
    expect((await r.call("login_character", { name: "alfa", race: 1, class: 1 })).text).toStartWith("logged in: Alfa");
    expect((await r.call("login_character", { name: "bravo", race: 1, class: 1 })).text).toStartWith("logged in: Bravo");
    expect([...r.stub.sessions.values()].map((s) => `${s.account}:${s.character}`)).toEqual(["POOL01:Alfa", "POOL02:Bravo"]);

    // The benchmark's own render for one character, the stack's plain roll-up for all.
    const one = await r.call("state_summary", { character: "Alfa" });
    expect(one.text).toContain("Alfa");
    expect(one.text).not.toStartWith("{");
    expect((await r.call("state_summary", {})).text).toStartWith("2 of 3 characters logged in: 2 alive");
    // A seat token is redacted from what a model is served, and from the records.
    const tokens = readRoster(r.runDir).map((e) => e.token);
    expect(tokens).toHaveLength(2);
    expect((await r.call("run_snippet", { code: "chars.Bravo.sdk.token" })).text).toContain("[redacted]");
    expect((await r.call("run_snippet", { code: "(await sdk.say('here')).ok", character: "Alfa" })).text).toContain("true");
    await r.sandbox.recordDrain();

    expect(statSync(join(r.runDir, ROSTER_FILE)).mode & 0o777).toBe(0o600);
    expect(readRoster(r.runDir).map((e) => [e.character, e.account, e.in])).toEqual([["Alfa", "POOL01", true], ["Bravo", "POOL02", true]]);
    expect(existsSync(join(r.runDir, SESSION_DIR))).toBe(false);
    expect(readdirSync(join(r.runDir, SESSIONS_DIR)).sort()).toEqual(["Alfa", "Bravo"]);
    expect(characterSessionDirs(r.runDir).sort()).toEqual([characterSessionDir(r.runDir, "Alfa"), characterSessionDir(r.runDir, "Bravo")]);
    expect(() => characterSessionDir(r.runDir, "../x")).toThrow("not a character name");
    for (const name of ["Alfa", "Bravo"]) {
      const dir = characterSessionDir(r.runDir, name);
      const reader = new SessionReader(dir);
      expect(reader.session()?.character?.name).toBe(name);
      const text = JSON.stringify(reader.rows("calls"));
      for (const t of tokens) expect(text).not.toContain(t);
    }
    const said = (name: string): number => (new SessionReader(characterSessionDir(r.runDir, name)).rows("calls") as CallRow[]).filter((x) => x.kind === "actions" && x.actions.some((a) => a.action === "say")).length;
    expect([said("Alfa"), said("Bravo")]).toEqual([1, 0]);

    // A provider pause keeps the sessions; the roster still says who was in the world.
    const before = r.roster.snapshot();
    await r.sandbox.stop();
    await r.roster.shutdown({ logout: false });
    expect(r.stub.sessions.size).toBe(2);
    expect(readRoster(r.runDir)).toEqual(before);
    for (const dir of characterSessionDirs(r.runDir)) {
      const v = validateSession(dir);
      expect(v.errors).toEqual([]);
      expect(v.session?.ended).not.toBeNull();
    }
    removeSessionRing(r.runDir);
    for (const dir of characterSessionDirs(r.runDir)) expect(existsSync(join(dir, "nearby"))).toBe(false);
    r.trajectory.close();
  }, 60_000);

  test("the turn context of a fan-out run is the roll-up, with no one character's event window", async () => {
    const r = rig("fan-2");
    const builder = new ContextBuilder({ config: r.config, sandbox: r.sandbox, scratchpad: r.scratchpad, trajectory: r.trajectory, watchdogs: new Watchdogs(r.config.watchdogs) });
    const empty = await builder.build(1, []);
    expect(empty).toContain("No character is logged in; use login_character.");
    expect(builder.sessionLive).toBe(false);
    await r.call("login_character", { name: "alfa", race: 1, class: 1 });
    await r.call("run_snippet", { code: "await sleep(50, { wake: false })" });
    const text = await builder.build(2, []);
    expect(text).toContain("1 of 3 characters logged in: 1 alive");
    expect(builder.sessionLive).toBe(true);
    await r.sandbox.stop();
    await r.roster.shutdown({ logout: true });
    expect(r.stub.sessions.size).toBe(0);
    expect(readRoster(r.runDir).map((e) => e.in)).toEqual([false]);
    r.trajectory.close();
  }, 60_000);
});
