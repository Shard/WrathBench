/** The admin page's forms and readings (`lib/admin.ts`): what each writes, and what it reads out of the config document. */
import { describe, expect, test } from "bun:test";
import {
  EMPTY_CREDENTIAL,
  campaignDoc,
  campaignRows,
  credentialDoc,
  fmtDelay,
  freeplayRows,
  jobDoc,
  nextQueueKey,
  publishedDefs,
  queueRows,
} from "../src/lib/admin";

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
  });

  test("what a form is missing is a sentence, not a write", () => {
    expect(credentialDoc(EMPTY_CREDENTIAL)).toBe("a credential needs an id");
    expect(credentialDoc({ ...EMPTY_CREDENTIAL, id: "x" })).toBe("pick a provider");
    expect(credentialDoc({ ...EMPTY_CREDENTIAL, id: "x", provider: "openrouter", secretEnv: "K", budget: "spend" })).toBe("a spend budget needs its limit");
  });
});

describe("the config document's sections", () => {
  test("freeplay agents are the entries with idle: unlimited", () => {
    expect(freeplayRows({ a: { model: "m/a", idle: "unlimited" }, b: { model: "m/b", idle: "none" }, c: { model: "m/c" } })).toEqual([
      { name: "a", model: "m/a", playing: true },
      { name: "b", model: "m/b", playing: false },
      { name: "c", model: "m/c", playing: false },
    ]);
    expect(freeplayRows(undefined)).toEqual([]);
  });

  test("campaign rows, and the published definitions newest version first", () => {
    expect(campaignRows({ sweep: { version: 2, enabled: true, assignments: [{ model: "a", runsPerCell: 3 }], concluded: [1] } })).toEqual([
      { name: "sweep", version: 2, enabled: true, assignments: [{ model: "a", runsPerCell: 3 }], account: null, credential: null, concluded: [1] },
    ]);
    expect(publishedDefs({ "b@1": {}, "a@1": {}, "a@3": {}, junk: {} })).toEqual([
      { id: "a", version: 3 },
      { id: "a", version: 1 },
      { id: "b", version: 1 },
    ]);
  });

  test("a new campaign is a published definition and its assignments, written disabled", () => {
    expect(campaignDoc({ def: "sweep@2", models: ["a", "b"], runsPerCell: "3" })).toEqual({
      key: "campaigns/sweep",
      body: { version: 2, enabled: false, assignments: [{ model: "a", runsPerCell: 3 }, { model: "b", runsPerCell: 3 }] },
    });
    expect(campaignDoc({ def: "", models: ["a"], runsPerCell: "1" })).toBe("pick a published definition");
    expect(campaignDoc({ def: "s@1", models: [], runsPerCell: "1" })).toBe("assign at least one roster entry");
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
    expect(jobDoc({ ref: "a", episode: "freeplay", repeat: "loop", enabled: true })).toEqual({ ref: "a", episode: "freeplay", repeat: "loop", enabled: true });
    expect(jobDoc({ ref: "a", episode: "e90", repeat: "0", enabled: true })).toBe("repeat is a whole number, or loop");
  });

  test("a delay reads in the unit it was set in", () => {
    expect(fmtDelay(0)).toBe("none");
    expect(fmtDelay(30_000)).toBe("30 s");
    expect(fmtDelay(900_000)).toBe("15 min");
  });
});
