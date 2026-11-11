/** The admin page's forms and readings (`lib/admin.ts`): what each writes, and what it reads out of the config document. */
import { describe, expect, test } from "bun:test";
import {
  CONFIG_SECTIONS,
  EMPTY_CREDENTIAL,
  campaignDoc,
  campaignRows,
  credentialDoc,
  credentialFormOf,
  fmtDelay,
  fixLabel,
  freeplayRows,
  healthTitle,
  healthTone,
  sectionOf,
  sectionOfKey,
  sectionsShown,
  storedCredentialRows,
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
    expect(credentialDoc({ ...EMPTY_CREDENTIAL, id: "x", provider: "openrouter", secretEnv: "K", slots: "" })).toBe("slots is a whole number");
  });

  test("a usage budget's two shares: freeplay its own where given, else the scored one", () => {
    const base = { ...EMPTY_CREDENTIAL, id: "c", provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", budget: "usage" as const, limit: "80" };
    expect(credentialDoc({ ...base, freeplayLimit: "95" })).toMatchObject({ body: { budget: { kind: "usage", scoredMaxPct: 80, freeplayMaxPct: 95 } } });
    expect(credentialDoc({ ...base, freeplayLimit: "x" })).toBe("the freeplay share is a percentage");
  });

  test("an edit is the whole row, its switch kept", () => {
    const row = { provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: 2, budget: { kind: "spend", usdPerDay: 5 }, billing: "paid", enabled: true };
    const form = credentialFormOf("or-1", row);
    expect(form).toEqual({ id: "or-1", provider: "openrouter", secretEnv: "OPENROUTER_KEY", slots: "2", billing: "paid", budget: "spend", limit: "5", freeplayLimit: "" });
    expect(credentialDoc(form, { enabled: true })).toEqual({ key: "credentials/or-1", body: row });
    // Back to the provider's default: the budget leaves the row, which only a whole-row write can do.
    expect(credentialDoc({ ...form, budget: "none" }, { enabled: true })).toEqual({ key: "credentials/or-1", body: { ...row, budget: undefined } });
  });
});

describe("credentialFormOf", () => {
  test("seeded from the row as written, not the effective budget: a subscription with none stays at the default", () => {
    expect(credentialFormOf("c", { provider: "claude", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", slots: 1, billing: "paid", enabled: false })).toMatchObject({ budget: "none", limit: "" });
    expect(credentialFormOf("c", { provider: "claude", secretEnv: "X", slots: 1, budget: { kind: "usage", scoredMaxPct: 70, freeplayMaxPct: 90 }, billing: "paid" })).toMatchObject({
      budget: "usage",
      limit: "70",
      freeplayLimit: "90",
    });
    // An equal pair reads as one number.
    expect(credentialFormOf("c", { budget: { kind: "usage", scoredMaxPct: 80, freeplayMaxPct: 80 } }).freeplayLimit).toBe("");
    expect(credentialFormOf("x", undefined)).toMatchObject({ id: "x", provider: "", slots: "" });
  });

  test("the rows come out of the config document by id, or none", () => {
    expect(storedCredentialRows({ credentials: { a: { provider: "openrouter" } } })).toEqual({ a: { provider: "openrouter" } });
    expect(storedCredentialRows({})).toEqual({});
  });
});

describe("health", () => {
  test("the tone: ok, warn for what clears by itself, err for what wants someone, dim for the switch and the unknown", () => {
    expect(["ok", "held", "unread", "auth-failed", "secret-missing", "quota-spent", "disabled"].map((s) => healthTone(s as never))).toEqual(["ok", "warn", "warn", "err", "err", "err", "dim"]);
    expect(healthTone(null)).toBe("dim");
  });

  test("the hover: since when and the provider's last answer", () => {
    const fmt = (t: number) => `@${t}`;
    expect(healthTitle({ state: "auth-failed", reason: "x", since: 1, lastCheck: { at: 2, http: 401, code: "api_key_expired" } }, fmt)).toBe("since @1 · last check @2 · HTTP 401 api_key_expired");
    expect(healthTitle({ state: "ok", reason: "", since: null, lastCheck: null }, fmt)).toBe("");
  });
});

describe("fixLabel", () => {
  test("a label, with until when where known; the sentence is the hover's", () => {
    expect(fixLabel({ kind: "wait-reset", until: 5, text: "wait for the reset" }, (t) => `@${t}`)).toBe("wait · until @5");
    expect(fixLabel({ kind: "raise-budget", text: "raise its budget, or wait for 00:00 UTC" }, String)).toBe("raise budget");
  });
});

describe("the config page's sections", () => {
  const ALL = { runner: true, evals: true, viewer: true };
  test("a route names a section this deployment has, or none", () => {
    expect(sectionOf("providers", ALL)).toBe("providers");
    expect(sectionOf(undefined, ALL)).toBeNull();
    expect(sectionOf("nope", ALL)).toBeNull();
    expect(sectionOf("campaigns", { ...ALL, evals: false })).toBeNull();
  });

  test("a group that is off takes its sections with it; the deployment's own stay", () => {
    expect(sectionsShown(ALL).map((s) => s.id)).toEqual(CONFIG_SECTIONS.map((s) => s.id));
    expect(sectionsShown({ runner: false, evals: false, viewer: true }).map((s) => s.id)).toEqual(["policy", "deployment", "history"]);
  });

  test("every store row key's raw editor sits in exactly one section, each collection beside its table", () => {
    const keys = ["credentials/or-1", "campaigns/deadmines", "campaign-defs/deadmines@4", "queue/0", "policy", "accounts", "preflight", "roster/opus"];
    expect(keys.map(sectionOfKey)).toEqual(["providers", "campaigns", "campaigns", "queue", "policy", "policy", "policy", "roster"]);
    const ids = new Set<string>(CONFIG_SECTIONS.map((s) => s.id));
    for (const k of keys) expect(ids.has(sectionOfKey(k))).toBe(true);
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
