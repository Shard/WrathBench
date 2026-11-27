/**
 * The shared smoke helpers (infra/smoke/lib/report.ts, events.ts, module.ts)
 * print what the smokes printed before they shared them: the log prefixes,
 * the failure messages and the verdict totals are read by the suite and by
 * whoever tails a smoke, so their spelling is pinned here. The event stream
 * and the request helpers run against a local stand-in for the module.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openEventStream, waitForEvent } from "./smoke/lib/events";
import { moduleAction, moduleRequest, moduleSession } from "./smoke/lib/module";
import { checks, stampedLog, taggedLog } from "./smoke/lib/report";

let printed: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  printed = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void printed.push(a.join(" ")));
});
afterEach(() => spy.mockRestore());

const failWith = (msg: string): never => {
  throw new Error(`failed: ${msg}`);
};

describe("the log prefixes", () => {
  test("tagged and stamped, the stamp padded to the width given", () => {
    taggedLog("probe")("in world");
    const started = Date.now() - 2_345;
    stampedLog("bank", started)("open");
    stampedLog("swim", started, 6)("dive");
    expect(printed[0]).toBe("[probe] in world");
    expect(printed[1]).toMatch(/^\[bank \+  2\.\ds\] open$/);
    expect(printed[2]).toMatch(/^\[swim \+   2\.\ds\] dive$/);
  });
});

describe("checks", () => {
  test("each verdict logged as it lands, a throw is that check's FAIL, the totals repeat each FAIL", async () => {
    const c = checks(taggedLog("t"));
    await c.check("a", () => ["PASS", "fine"]);
    await c.check("b", async () => {
      throw new Error("boom");
    });
    c.report("SKIP", "c", "not here");
    expect(c.totals()).toBe(true);
    expect(printed).toEqual(["[t] PASS a: fine", "[t] FAIL b: boom", "[t] SKIP c: not here", "totals: 1 pass, 1 fail, 1 skip, 0 info", "  FAIL b: boom"]);
  });
});

describe("waitForEvent", () => {
  test("the first match from `from`, polled until it arrives", async () => {
    const buf: any[] = [{ n: 1 }, { n: 2 }];
    setTimeout(() => buf.push({ n: 3 }), 30);
    expect(await waitForEvent(buf, (e) => e.n >= 1, 1_000, "any", failWith, { from: 1 })).toEqual({ n: 2 });
    expect(await waitForEvent(buf, (e) => e.n === 3, 1_000, "three", failWith, { pollMs: 10 })).toEqual({ n: 3 });
  });

  test("the smoke's own fail on timeout, with the smokes' words", async () => {
    await expect(waitForEvent([], () => true, 20, "SMSG_NOTHING", failWith, { pollMs: 5 })).rejects.toThrow("failed: timed out waiting for SMSG_NOTHING");
  });
});

describe("against a stand-in module", () => {
  const seen: { method: string; path: string; body: any }[] = [];
  const server = Bun.serve<string | null>({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") return srv.upgrade(req, { data: url.searchParams.get("token") }) ? undefined : new Response("no", { status: 400 });
      const body: any = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      seen.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/text") return new Response("not json");
      if (url.pathname === "/action") return Response.json(body?.action === "stop" ? { ok: true, stopped: true } : { ok: false, error: "rooted" }, { status: body?.action === "stop" ? 200 : 409 });
      if (url.pathname === "/session" && req.method === "POST") return Response.json({ ok: true, inWorld: body?.class === 1 });
      if (url.pathname === "/session") return Response.json({ ok: false, error: "no_session" }, { status: 404 });
      return Response.json({ ok: true });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ opcode: "A", token: ws.data }));
        ws.send("{torn");
        ws.send(JSON.stringify({ opcode: "THROWS" }));
        ws.send(JSON.stringify({ opcode: "B" }));
      },
      message() {},
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;

  test("the request helper: status and JSON, undefined for a body that is not JSON", async () => {
    const req = moduleRequest(base);
    expect(await req("POST", "/x", { a: 1 })).toEqual({ status: 200, json: { ok: true } });
    expect(await req("GET", "/text")).toEqual({ status: 200, json: undefined });
    expect(seen.at(-2)).toEqual({ method: "POST", path: "/x", body: { a: 1 } });
  });

  test("POST /action under the token, the smoke's fail on anything but 200 ok", async () => {
    const action = moduleAction(moduleRequest(base), "tok", failWith);
    expect(await action("stop")).toEqual({ ok: true, stopped: true });
    expect(seen.at(-1)?.body).toEqual({ token: "tok", action: "stop" });
    await expect(action("move_to", { x: 1 })).rejects.toThrow('failed: action move_to failed: 409 {"ok":false,"error":"rooted"}');
  });

  test("the raw session: in world or fail, and its delete", async () => {
    const who = { token: "tok", account: "SMOKE2", character: "Smokekc", race: 1 };
    expect(await moduleSession(moduleRequest(base), { ...who, class: 1 }, failWith).create()).toEqual({ ok: true, inWorld: true });
    expect(seen.at(-1)?.body).toEqual({ ...who, class: 1 });
    const offline = moduleSession(moduleRequest(base), { ...who, class: 2 }, failWith);
    await expect(offline.create()).rejects.toThrow('failed: session failed: {"ok":true,"inWorld":false}');
    await expect(offline.end()).rejects.toThrow('failed: session delete failed: {"ok":false,"error":"no_session"}');
  });

  test("the event stream: each frame to the handler; a torn frame or a throwing handler to the other, or dropped", async () => {
    const got: string[] = [];
    const bad: string[] = [];
    const onEvent = (e: any) => {
      if (e.opcode === "THROWS") throw new Error("handler");
      got.push(e.opcode === "A" ? `A:${e.token}` : e.opcode);
    };
    const ws = await openEventStream(base.replace(/^http/, "ws"), "tok en", onEvent, (raw) => bad.push(raw));
    const quiet = await openEventStream(base.replace(/^http/, "ws"), "t2", onEvent);
    await waitForEvent(got, (x) => x === "B", 2_000, "B", failWith, { pollMs: 5 });
    await Bun.sleep(50);
    ws.close();
    quiet.close();
    expect(got.filter((x) => x.startsWith("A:")).sort()).toEqual(["A:t2", "A:tok en"]);
    expect(bad).toEqual(["{torn", '{"opcode":"THROWS"}']);
  });

  test("an event stream that cannot open rejects with the smokes' words", async () => {
    await expect(openEventStream("ws://127.0.0.1:9", "tok", () => {})).rejects.toThrow(/^ws error: /);
  });
});
