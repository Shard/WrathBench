/**
 * A credential's health (runner/src/credential-health.ts): every issue read off
 * state that already exists, the status the worst of them, and `unknown` —
 * never `ok` — while nobody is up to say.
 */
import { describe, expect, test } from "bun:test";
import { credentialHealth, ISSUE_CODES, ISSUES, worstLevel, type SupervisorCredentialView } from "../src/credential-health";

const NOW = Date.parse("2030-03-14T12:00:00Z");
const BEAT = NOW - 20_000;

const sup = (over: Partial<SupervisorCredentialView> = {}): SupervisorCredentialView => ({ secretSet: true, held: {}, lastError: null, ...over });
const health = (over: Partial<Parameters<typeof credentialHealth>[0]> = {}) =>
  credentialHealth({ enabled: true, secretEnv: "OPENROUTER_KEY", holds: "key", up: true, heartbeatAt: BEAT, supervisor: sup(), deployed: true, ...over });
const codes = (h: ReturnType<typeof credentialHealth>) => h.issues.map((i) => i.code);

describe("credentialHealth", () => {
  test("enabled, set, deployed and nothing held: ok, with no issues", () => {
    expect(health()).toEqual({ status: "ok", issues: [] });
  });

  test("no supervisor up, or one that has not read the row: unknown, never ok", () => {
    const down = health({ up: false, supervisor: undefined });
    expect(down.status).toBe("unknown");
    expect(down.issues[0]).toMatchObject({ code: "supervisor-down", lastSeen: BEAT });
    expect(health({ supervisor: undefined })).toMatchObject({ status: "unknown", issues: [{ code: "not-seen" }] });
    // What the viewer knows by itself still counts without one.
    expect(health({ up: false, supervisor: undefined, deployed: false })).toMatchObject({ status: "disabled" });
  });

  test("switched off is disabled, and still lists what else is wrong", () => {
    const h = health({ enabled: false, supervisor: sup({ secretSet: false }) });
    expect(h.status).toBe("disabled");
    expect(codes(h)).toEqual(["switched-off", "secret-missing"]);
  });

  test("a missing secret and a variable the chart does not hand out each disable it, naming the variable only", () => {
    expect(health({ supervisor: sup({ secretSet: false }) }).issues).toEqual([
      { code: "secret-missing", level: "disabled", message: "OPENROUTER_KEY not set", since: null, lastSeen: BEAT, until: null },
    ]);
    expect(health({ holds: "home", secretEnv: "CODEX_HOME", supervisor: sup({ secretSet: false }) }).issues[0]!.message).toBe("CODEX_HOME not set, or no such directory");
    expect(health({ deployed: false })).toMatchObject({ status: "disabled", issues: [{ code: "not-deployed", message: "OPENROUTER_KEY not in the chart's modelKeys" }] });
    expect(health({ deployed: null }).status).toBe("ok");
  });

  test("a run paused on the credential: auth-failed disables it, quota-exhausted degrades it, anything else is not the credential's", () => {
    const at = NOW - 3_600_000;
    expect(health({ supervisor: sup({ lastError: { reason: "auth-failed", at } }) }).issues).toEqual([
      { code: "auth-failed", level: "disabled", message: "auth failed on a run", since: null, lastSeen: at, until: null },
    ]);
    expect(health({ supervisor: sup({ lastError: { reason: "quota-exhausted", at } }) }).status).toBe("degraded");
    expect(health({ supervisor: sup({ lastError: { reason: "rate-limited", at } }) }).status).toBe("ok");
  });

  test("budget holds by code: a spent window or a used day disables, a threshold degrades; one issue per code", () => {
    const until = NOW + 7_200_000;
    const threshold = health({
      supervisor: sup({ held: { scored: "x", freeplay: "y" }, holds: { scored: { code: "usage-threshold", until }, freeplay: { code: "usage-threshold", until } } }),
    });
    expect(threshold.status).toBe("degraded");
    expect(threshold.issues).toEqual([
      { code: "usage-threshold", level: "degraded", message: "usage at its threshold (scored, freeplay)", since: null, lastSeen: BEAT, until },
    ]);
    const scoredOnly = health({ supervisor: sup({ held: { scored: "x" }, holds: { scored: { code: "usage-threshold", until } } }) });
    expect(scoredOnly.issues[0]!.message).toBe("usage at its threshold (scored)");
    expect(health({ supervisor: sup({ held: { scored: "x", freeplay: "y" }, holds: { scored: { code: "usage-spent", until }, freeplay: { code: "usage-spent", until } } }) }).status).toBe("disabled");
    const runs = health({ supervisor: sup({ held: { scored: "x", freeplay: "y" }, holds: { scored: { code: "runs-budget", until }, freeplay: { code: "runs-budget", until } } }) });
    expect(runs).toMatchObject({ status: "disabled", issues: [{ code: "runs-budget", message: "today's runs are used", until }] });
    expect(health({ supervisor: sup({ held: { scored: "x", freeplay: "y" }, holds: { scored: { code: "spend-budget", until }, freeplay: { code: "spend-budget", until } } }) }).issues[0]!.code).toBe("spend-budget");
  });

  test("a supervisor that publishes no hold codes: a held class reads as held by its budget, degraded", () => {
    const h = health({ supervisor: sup({ held: { freeplay: "credential x: ..." } }) });
    expect(h).toMatchObject({ status: "degraded", issues: [{ code: "budget-held", message: "held by its budget (freeplay)", until: null }] });
  });

  test("every code has a row, and the worst level wins in the order disabled, degraded, unknown, ok", () => {
    for (const c of ISSUE_CODES) expect(ISSUES[c]).toBeDefined();
    expect(worstLevel([])).toBe("ok");
    expect(worstLevel([{ level: "unknown" }, { level: "degraded" }])).toBe("degraded");
    expect(worstLevel([{ level: "degraded" }, { level: "disabled" }, { level: "unknown" }])).toBe("disabled");
  });
});
