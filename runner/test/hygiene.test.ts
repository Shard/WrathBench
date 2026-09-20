/**
 * Episode hygiene: the assigned character is gone only when an OK
 * listing says so. Replays the 2026-08-24 sequence that let a scored run start
 * on its predecessor's level-6 character: delete times out (player still
 * loaded), the re-list is refused during the core's linger.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunConfig, newSessionToken } from "../src/config";
import { characterOwners, clearAccountCharacters } from "../src/hygiene";
import { Trajectory } from "../src/trajectory";

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

const enumOf = (...chars: { name: string; guid: string; level?: number }[]) => ({
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

describe("clearAccountCharacters never deletes a character a run still owns (2026-09-20)", () => {
  // The listing the incident's launch saw: Aurelian, level 7, guid 625 — the
  // character of a freeplay run whose runner had been SIGKILLed with no
  // verdict — next to a level-1 leftover of a scored run that ended.
  const listing = enumOf({ name: "Aurelian", guid: "625", level: 7 }, { name: "Novice", guid: "631", level: 1 });
  const owners = new Map([
    ["aurelian", { runId: "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919", ended: false }],
    ["novice", { runId: "fleet-ox-e90-stealth-ox-alpha-free-20260919", ended: true }],
  ]);

  test("an un-ended run's character is kept and said loudly; the ended run's leftover goes", async () => {
    const { f, calls } = fakeFetch({ list: [listing, enumOf({ name: "Aurelian", guid: "625", level: 7 })], del: [deleted("Novice")] });
    const lines: string[] = [];
    const out = await clearAccountCharacters({ ...base, fetch: f, owners, log: (l) => lines.push(l) });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(calls.filter((c) => c.path === "/character-delete").map((c) => c.body["character"])).toEqual(["Novice"]);
    expect(out.cleared).toBe(1);
    expect(out.leftover).toEqual([]);
    expect(out.protected).toEqual([
      { name: "Aurelian", guid: "625", level: 7, why: "belongs to run fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919, which has not ended" },
    ]);
    expect(lines.some((l) => l.includes("KEEPING Aurelian (guid 625, level 7)") && l.includes("has not ended"))).toBe(true);
    // Said once, not once per listing round.
    expect(lines.filter((l) => l.includes("KEEPING Aurelian")).length).toBe(1);
  });

  test("a levelled character nobody accounts for is kept without --allow-character-delete, and deleted with it", async () => {
    const stray = enumOf({ name: "Wanderer", guid: "700", level: 4 });
    const held = await clearAccountCharacters({ ...base, fetch: fakeFetch({ list: [stray], del: [] }).f, owners: new Map() });
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error("unreachable");
    expect(held.protected.map((p) => p.name)).toEqual(["Wanderer"]);
    expect(held.protected[0]!.why).toContain("--allow-character-delete");
    expect(held.cleared).toBe(0);

    const { f, calls } = fakeFetch({ list: [stray, enumOf()], del: [deleted("Wanderer")] });
    const allowed = await clearAccountCharacters({ ...base, fetch: f, owners: new Map(), allowCharacterDelete: true });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error("unreachable");
    expect(calls.filter((c) => c.path === "/character-delete").map((c) => c.body["character"])).toEqual(["Wanderer"]);
    expect(allowed.protected).toEqual([]);
    expect(allowed.cleared).toBe(1);
  });

  test("the flag does not reach an un-ended run's character: that one is never a leftover", async () => {
    const { f, calls } = fakeFetch({ list: [enumOf({ name: "Aurelian", guid: "625", level: 7 })], del: [] });
    const out = await clearAccountCharacters({ ...base, fetch: f, owners, allowCharacterDelete: true });
    expect(out.ok).toBe(true);
    expect(calls.filter((c) => c.path === "/character-delete")).toEqual([]);
  });

  test("a level-1 stranger and an ended run's levelled leftover are still cleared, as before", async () => {
    const { f, calls } = fakeFetch({
      list: [enumOf({ name: "Fresh", guid: "1", level: 1 }, { name: "Novice", guid: "631", level: 5 }), enumOf()],
      del: [deleted("x")],
    });
    const out = await clearAccountCharacters({ ...base, fetch: f, owners });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(calls.filter((c) => c.path === "/character-delete").map((c) => c.body["character"]).sort()).toEqual(["Fresh", "Novice"]);
    expect(out.protected).toEqual([]);
  });
});

describe("characterOwners", () => {
  /** A run directory on `account` that played `character`, ended or not. */
  function run(runsDir: string, runId: string, o: { account: string; character: string; startedAt: number; ended?: string; archived?: boolean }): void {
    const dir = join(runsDir, ...(o.archived === true ? ["archive", runId] : [runId]));
    mkdirSync(dir, { recursive: true });
    const traj = new Trajectory(dir);
    const config = loadRunConfig({ runId, token: newSessionToken(), driver: "stub", episode: "freeplay", runsDir, moduleUrl: "http://127.0.0.1:9", account: o.account, character: o.character, race: 3, class: 2 });
    traj.writeMeta({ runId, harnessVersion: "0.0.0-test", startedAt: o.startedAt, config });
    if (o.ended !== undefined) traj.setTermination(runId, o.ended as "manual", "test");
    traj.close();
  }

  test("the newest run per name on the account decides, archived runs included, case-folded, the asking launch excluded", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "wrathbench-owners-"));
    run(runsDir, "old-aurelian", { account: "RUNNER2", character: "Aurelian", startedAt: 1, ended: "idle" });
    run(runsDir, "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919", { account: "runner2", character: "Aurelian", startedAt: 2 });
    run(runsDir, "novice-run", { account: "RUNNER2", character: "Novice", startedAt: 3, ended: "episode-limit", archived: true });
    run(runsDir, "elsewhere", { account: "RUNNER3", character: "Stranger", startedAt: 4 });
    run(runsDir, "me-now", { account: "RUNNER2", character: "Suggested", startedAt: 5 });
    const owners = characterOwners(runsDir, "RUNNER2", "me-now");
    expect(owners.get("aurelian")).toEqual({ runId: "fleet-deepseek-v41-flash-freeplay-deepseek-v4-1-flash-20260919", ended: false });
    expect(owners.get("novice")).toEqual({ runId: "novice-run", ended: true });
    expect(owners.has("stranger")).toBe(false);
    expect(owners.has("suggested")).toBe(false);
    // No runs directory at all is simply no owners.
    expect(characterOwners(join(runsDir, "nowhere"), "RUNNER2").size).toBe(0);
  });
});
