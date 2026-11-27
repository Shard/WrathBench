/** The admin page's forms (`lib/admin.ts`): what each writes into the config store, and the connect block's secret handling. */
import { describe, expect, test } from "bun:test";
import { CONNECT_FORMS, EMPTY_CREDENTIAL, campaignDoc, connectSnippet, credentialDoc, credentialFormOf, jobDoc, nextQueueKey, queueRows } from "../src/lib/admin";

describe("credentialDoc", () => {
  test("a credential is written disabled, with its budget's one number in the shape the store reads", () => {
    const base = { ...EMPTY_CREDENTIAL, id: "or-2", provider: "openrouter", secretEnv: " OPENROUTER_KEY_2 ", slots: "2" };
    expect(credentialDoc(base)).toEqual({
      key: "credentials/or-2",
      body: { provider: "openrouter", secretEnv: "OPENROUTER_KEY_2", slots: 2, billing: "paid", enabled: false },
    });
    expect(credentialDoc({ ...base, budget: "spend", limit: "5" })).toMatchObject({ body: { budget: { kind: "spend", usdPerDay: 5 } } });
    expect(credentialDoc({ ...base, budget: "runs", limit: "40" })).toMatchObject({ body: { budget: { kind: "runs", perDay: 40 } } });
    expect(credentialDoc({ ...base, budget: "usage", limit: "70" })).toMatchObject({ body: { budget: { kind: "usage", scoredMaxPct: 70, freeplayMaxPct: 70 } } });
    expect(credentialDoc({ ...base, budget: "usage", limit: "80", freeplayLimit: "95" })).toMatchObject({ body: { budget: { kind: "usage", scoredMaxPct: 80, freeplayMaxPct: 95 } } });
  });

  test("what a form is missing is a sentence, not a write", () => {
    expect(credentialDoc(EMPTY_CREDENTIAL)).toBe("a credential needs an id");
    expect(credentialDoc({ ...EMPTY_CREDENTIAL, id: "x", provider: "openrouter", secretEnv: "K", budget: "spend" })).toBe("a spend budget needs its limit");
    expect(credentialDoc({ ...EMPTY_CREDENTIAL, id: "x", provider: "claude", secretEnv: "K", budget: "usage", limit: "80", freeplayLimit: "x" })).toBe("the freeplay share is a percentage");
  });

  test("an edit is the whole row, its switch kept", () => {
    const row = { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, budget: { kind: "spend", usdPerDay: 5 }, billing: "paid", enabled: true };
    const form = credentialFormOf("or-1", row);
    expect(credentialDoc(form, { enabled: true })).toEqual({ key: "credentials/or-1", body: row });
    // Back to the provider's default: the budget leaves the row, which only a whole-row write can do.
    expect(credentialDoc({ ...form, budget: "none" }, { enabled: true })).toEqual({ key: "credentials/or-1", body: { ...row, budget: undefined } });
  });
});

describe("the wrath-mcp section", () => {
  test("the connect block names the agent's own module URL, never the viewer's, and fills in no secret", () => {
    for (const f of CONNECT_FORMS) {
      const s = connectSnippet(f.id);
      expect(s).toContain("http://127.0.0.1:8086");
      expect(s).toContain("WRATHBENCH_MODULE_SECRET");
      expect(s).toContain("<port secret>");
      for (const p of ["<ACCOUNT>", "<checkout>/wrath-mcp/mcp/src/main.ts", "<session store>"]) expect(s).toContain(p);
      expect(s).not.toContain("worldserver:8086");
    }
  });
});

describe("campaign and queue writes", () => {
  test("a new campaign is a published definition and its assignments, written disabled", () => {
    expect(campaignDoc({ def: "sweep@2", models: ["a", "b"], runsPerCell: "3" })).toEqual({
      key: "campaigns/sweep",
      body: { version: 2, enabled: false, assignments: [{ model: "a", runsPerCell: 3 }, { model: "b", runsPerCell: 3 }] },
    });
    expect(campaignDoc({ def: "", models: ["a"], runsPerCell: "1" })).toBe("pick a published definition");
  });

  test("queue rows zip with their keys, and a new job goes one past the highest", () => {
    const keys = ["roster/a", "queue/0", "queue/4"];
    const rows = queueRows(
      [
        { ref: "a", episode: "e90", repeat: 3, enabled: true },
        { ref: ["a", "b"], episode: "freeplay", repeat: "loop", enabled: false, account: "RUNNER" },
      ],
      keys,
    );
    expect(rows.map((r) => [r.key, r.refs, r.episode, r.repeat, r.enabled, r.account])).toEqual([
      ["queue/0", ["a"], "e90", 3, true, null],
      ["queue/4", ["a", "b"], "freeplay", "loop", false, "RUNNER"],
    ]);
    expect(nextQueueKey(keys)).toBe("queue/5");
    expect(nextQueueKey([])).toBe("queue/0");
    expect(jobDoc({ ref: "a", episode: "e90", repeat: "0", enabled: true })).toBe("repeat is a whole number, or loop");
  });
});
