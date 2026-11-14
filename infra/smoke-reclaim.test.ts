/**
 * The suite's reclaim step (infra/smoke/lib/reclaim.ts) against a stub module:
 * an account nothing holds is left alone and nothing is printed; an account a
 * killed process left a session on is reclaimed under a fresh token, through
 * the core's release window, and the throwaway character is deleted again.
 */
import { describe, expect, test } from "bun:test";
import { createWithReclaim, type ModuleReply, reclaimAccount } from "./smoke/lib/reclaim";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** A stub module: each route answers its replies in turn, the last one repeating. */
function stubModule(routes: Record<string, ModuleReply[]>) {
  const calls: Call[] = [];
  const seen: Record<string, number> = {};
  const request = async (method: string, path: string, body?: unknown): Promise<ModuleReply> => {
    calls.push({ method, path, body: body as Record<string, unknown> | undefined });
    const key = `${method} ${path}`;
    const replies = routes[key];
    if (replies === undefined) throw new Error(`stub: no route ${key}`);
    const n = seen[key] ?? 0;
    seen[key] = n + 1;
    return replies[Math.min(n, replies.length - 1)]!;
  };
  return { calls, request };
}

const TOKEN = "smoke-suite-reclaim-smoke2-0f1e2d3c-4b5a-4968-8776-655443322110";
const TIMEOUT: ModuleReply = { status: 504, json: { ok: false, error: "timeout" } };
const IN_WORLD: ModuleReply = { status: 200, json: { ok: true, account: "SMOKE2", character: "Rclabcdefgh", guid: "7", inWorld: true } };
const noSleep = async () => {};

describe("reclaimAccount", () => {
  test("an account nothing holds: one listing, no session, nothing printed", async () => {
    const m = stubModule({ "POST /characters": [{ status: 200, json: { ok: true, enum: { count: 1, characters: [] } } }] });
    const logs: string[] = [];
    const r = await reclaimAccount({ request: m.request, account: "SMOKE2", token: TOKEN, log: (s) => void logs.push(s), sleep: noSleep });
    expect(r).toEqual({ leaked: false });
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /characters"]);
    expect(m.calls[0]!.body).toEqual({ token: `${TOKEN}-list`, account: "SMOKE2" });
    expect(logs).toEqual([]);
  });

  test("a leaked session: the create reclaims through 504s, then the session and the throwaway are deleted", async () => {
    const m = stubModule({
      "POST /characters": [{ status: 400, json: { ok: false, error: "account_in_use" } }],
      "POST /session": [TIMEOUT, TIMEOUT, IN_WORLD],
      "DELETE /session": [{ status: 200, json: { ok: true } }],
      "POST /character-delete": [{ status: 400, json: { ok: false, error: "account_in_use" } }, TIMEOUT, { status: 200, json: { ok: true, deleted: true } }],
    });
    const logs: string[] = [];
    const r = await reclaimAccount({ request: m.request, account: "SMOKE2", token: TOKEN, character: "Rclabcdefgh", log: (s) => void logs.push(s), sleep: noSleep });
    expect(r).toEqual({ leaked: true, ok: true, held: "400 account_in_use" });
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /characters",
      "POST /session",
      "POST /session",
      "POST /session",
      "DELETE /session",
      "POST /character-delete",
      "POST /character-delete",
      "POST /character-delete",
    ]);
    // Every create is under the reclaim's own token, for a throwaway it can create.
    for (const c of m.calls.filter((c) => c.path === "/session" && c.method === "POST")) {
      expect(c.body).toEqual({ token: TOKEN, account: "SMOKE2", character: "Rclabcdefgh", race: 1, class: 1 });
    }
    expect(m.calls.find((c) => c.method === "DELETE")!.body).toEqual({ token: TOKEN });
    // Each delete attempt under its own token derived from it, for the throwaway on this account.
    expect(m.calls.filter((c) => c.path === "/character-delete").map((c) => c.body)).toEqual(
      [0, 1, 2].map((n) => ({ token: `${TOKEN}-del${n}`, account: "SMOKE2", character: "Rclabcdefgh" })),
    );
    expect(logs[0]).toContain("reclaim SMOKE2: POST /characters answered 400 account_in_use");
    expect(logs.filter((l) => l.includes("still draining"))).toHaveLength(2);
    expect(logs.at(-1)).toBe("reclaim SMOKE2: reclaimed; the throwaway Rclabcdefgh is deleted");
  });

  test("a throwaway name is valid for the game when none is given", async () => {
    const m = stubModule({
      "POST /characters": [{ status: 400, json: { ok: false, error: "account_in_use" } }],
      "POST /session": [IN_WORLD],
      "DELETE /session": [{ status: 200, json: { ok: true } }],
      "POST /character-delete": [{ status: 200, json: { ok: true, deleted: true } }],
    });
    await reclaimAccount({ request: m.request, account: "SMOKE3", token: TOKEN, log: () => {}, sleep: noSleep });
    const name = String(m.calls.find((c) => c.path === "/session")!.body!["character"]);
    expect(name).toMatch(/^Rcl[a-z]{8}$/);
    expect(m.calls.find((c) => c.path === "/character-delete")!.body!["character"]).toBe(name);
  });

  test("a create that never converges is a named failure, and the cleanup still runs", async () => {
    const m = stubModule({
      "POST /characters": [{ status: 400, json: { ok: false, error: "account_in_use" } }],
      "POST /session": [TIMEOUT],
      "DELETE /session": [{ status: 404, json: { ok: false, error: "no_session" } }],
      "POST /character-delete": [{ status: 400, json: { ok: false, error: "character_not_found" } }],
    });
    const r = await reclaimAccount({ request: m.request, account: "SMOKE4", token: TOKEN, character: "Rclabcdefgh", log: () => {}, sleep: noSleep });
    expect(r).toMatchObject({ leaked: true, ok: false, held: "400 account_in_use" });
    expect(r.leaked && !r.ok && r.why).toContain("reclaim_never_converged");
    expect(m.calls.filter((c) => c.method === "POST" && c.path === "/session")).toHaveLength(25);
    expect(m.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(m.calls.some((c) => c.path === "/character-delete")).toBe(true);
  });
});

describe("createWithReclaim", () => {
  test("retries only 504 timeout; any other refusal comes back at once", async () => {
    const m = stubModule({ "POST /session": [{ status: 400, json: { ok: false, error: "account_in_use" } }] });
    const r = await createWithReclaim({
      request: m.request,
      body: { token: TOKEN, account: "PROBE", character: "Rclabcdefgh", race: 1, class: 1 },
      log: () => {},
      sleep: noSleep,
    });
    expect(r.json.error).toBe("account_in_use");
    expect(m.calls).toHaveLength(1);
  });
});
