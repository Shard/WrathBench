/**
 * Episode hygiene: the assigned character is gone only when an OK
 * listing says so. Replays the 2026-08-24 sequence that let a scored run start
 * on its predecessor's level-6 character: delete times out (player still
 * loaded), the re-list is refused during the core's linger.
 */
import { describe, expect, test } from "bun:test";
import { clearAccountCharacters } from "../src/hygiene";

type Reply = { status?: number; body: unknown };

function fakeFetch(script: { list: Reply[]; del: Reply[] }) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const f = ((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const queue = path === "/characters" ? script.list : script.del;
    const r = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const enumOf = (...chars: { name: string; guid: string }[]) => ({
  body: { ok: true, token: "t", enum: { count: chars.length, characters: chars } },
});
const refused = { status: 409, body: { ok: false, error: "account_in_use" } };
const deleted = (name: string) => ({ body: { ok: true, token: "t", character: name, deleted: true } });
const timeout = { status: 504, body: { ok: false, error: "timeout" } };

const base = { moduleUrl: "http://module", token: "tok", account: "RUNNER", sleep: () => Promise.resolve() };

describe("clearAccountCharacters", () => {
  test("the 2026-08-24 sequence: timed-out delete then a refused re-list is NOT clear", async () => {
    const { f } = fakeFetch({
      list: [enumOf({ name: "Fleetsonnlo", guid: "283" }, { name: "Fleetsonnet", guid: "294" }), refused],
      del: [deleted("Fleetsonnlo"), timeout, timeout, timeout],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, maxAttempts: 3 });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.reason).toContain("could not obtain a character listing");
    expect(out.seen.get("fleetsonnet")).toBe("294");
  });

  test("a refused listing is retried, and a later OK listing without the name clears", async () => {
    const { f, calls } = fakeFetch({
      list: [refused, refused, enumOf({ name: "Fleetsonnet", guid: "294" }), enumOf()],
      del: [deleted("Fleetsonnet")],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.cleared).toBe(1);
    expect(out.leftover).toEqual([]);
    expect(calls.filter((c) => c.path === "/characters").length).toBe(4);
    expect(calls.filter((c) => c.path === "/character-delete").length).toBe(1);
  });

  test("a name that survives every delete no longer blocks the run — it is a slot-eater the model is told about", async () => {
    // No name is assigned any more (the model picks its own), so a survivor
    // is not a precondition violation: it is a name that must not be chosen.
    const { f } = fakeFetch({
      list: [enumOf({ name: "Fleetsonnet", guid: "294" })],
      del: [timeout],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, maxAttempts: 2 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.leftover).toEqual(["Fleetsonnet"]);
  });

  test("other survivors only eat a slot; the run proceeds", async () => {
    const { f } = fakeFetch({
      list: [enumOf({ name: "Fleetsonnet", guid: "294" }, { name: "Stuck", guid: "9" }), enumOf({ name: "Stuck", guid: "9" })],
      del: [deleted("x"), timeout],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, maxAttempts: 2 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.leftover).toEqual(["Stuck"]);
    expect(out.cleared).toBe(1);
    expect([...out.seen.values()].sort()).toEqual(["294", "9"]);
  });

  test("an empty account is clear on the first listing with no deletes", async () => {
    const { f, calls } = fakeFetch({ list: [enumOf()], del: [] });
    const out = await clearAccountCharacters({ ...base, fetch: f });
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});

describe("clearAccountCharacters with no module listening", () => {
  test("a transport failure before any listing skips hygiene, as before", async () => {
    const f = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const lines: string[] = [];
    const out = await clearAccountCharacters({ ...base, fetch: f, log: (l) => lines.push(l) });
    expect(out.ok).toBe(true);
    expect(lines[0]).toContain("skipped");
  });
});

describe("clearAccountCharacters with model-chosen names", () => {
  test("deletes every leftover whatever it is called, not just the assigned name", async () => {
    // The model names its own character, so the last episode's leftover is
    // whatever it called itself. Hygiene lists the account and deletes what it
    // finds; no name is assigned for it to key on.
    const { f, calls } = fakeFetch({
      list: [enumOf({ name: "Grimjaw", guid: "701" }, { name: "Zeliana", guid: "702" }), enumOf()],
      del: [deleted("Grimjaw")],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, maxAttempts: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.cleared).toBe(2);
    expect(out.leftover).toEqual([]);
    // Both names went through the client delete path, and the guids of both
    // are returned so the first-observation tripwire can recognise them.
    expect(calls.filter((c) => c.path === "/character-delete").map((c) => c.body["character"]).sort()).toEqual([
      "Grimjaw",
      "Zeliana",
    ]);
    expect([...out.seen.entries()].sort()).toEqual([
      ["grimjaw", "701"],
      ["zeliana", "702"],
    ]);
  });

  test("a survivor still lets the run start, and is named to the model", async () => {
    // `leftover` is what run.ts puts in the launch notice: createSession
    // REUSES a character of the name it is given, so a model that picked
    // `Grimjaw` here would land on a used one.
    const { f } = fakeFetch({
      list: [enumOf({ name: "Grimjaw", guid: "701" }), enumOf({ name: "Grimjaw", guid: "701" })],
      del: [timeout],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, maxAttempts: 2 });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.leftover).toEqual(["Grimjaw"]);
  });
});

describe("clearAccountCharacters with keep", () => {
  test("a kept character is left standing and reported; the rest is cleared and it is not a leftover", async () => {
    const { f, calls } = fakeFetch({
      list: [enumOf({ name: "Bromdir", guid: "310" }, { name: "Novice", guid: "311" }), enumOf({ name: "Bromdir", guid: "310" })],
      del: [deleted("Novice")],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, keep: ["bromdir"] });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.cleared).toBe(1);
    expect(out.leftover).toEqual([]);
    expect(out.kept).toEqual([{ name: "Bromdir", guid: "310" }]);
    expect(calls.filter((c) => c.path === "/character-delete").map((c) => c.body["character"])).toEqual(["Novice"]);
    // The kept guid is still in `seen`: a scored run that names it is caught by the tripwire.
    expect(out.seen.get("bromdir")).toBe("310");
  });

  test("a kept name that is not on the account is simply absent from kept", async () => {
    const { f } = fakeFetch({ list: [enumOf()], del: [] });
    const out = await clearAccountCharacters({ ...base, fetch: f, keep: ["Bromdir"] });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.kept).toEqual([]);
  });
});
