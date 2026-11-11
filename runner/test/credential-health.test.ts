/**
 * A credential's health (runner/src/credential-health.ts): one state, the
 * first in precedence order that applies, read off state that already exists
 * and a reader's last read; its windows as meters; and the fix.
 */
import { describe, expect, test } from "bun:test";
import { credentialHealth, credentialWindows, HEALTH_STATES, windowName, type CredentialRead, type HealthInput } from "../src/credential-health";

const NOW = Date.parse("2030-03-14T12:00:00Z");
const H = 3_600_000;

const input = (over: Partial<HealthInput> = {}): HealthInput => ({
  enabled: true,
  secretEnv: "OPENCODE_KEY",
  holds: "key",
  secretSet: true,
  deployed: true,
  holdsOf: {},
  lastError: null,
  ...over,
});
const state = (over: Partial<HealthInput> = {}) => credentialHealth(input(over)).health.state;
const read = (over: Partial<CredentialRead>): CredentialRead => ({ at: NOW - 60_000, http: 200, classification: "ok", ...over });

describe("credentialHealth", () => {
  test("nothing wrong: ok, no fix, and the last read still reported", () => {
    expect(credentialHealth(input({ read: read({}) }))).toEqual({
      health: { state: "ok", reason: "", since: null, lastCheck: { at: NOW - 60_000, http: 200 } },
      fix: null,
    });
    expect(credentialHealth(input()).health.lastCheck).toBeNull();
  });

  test("the first state that applies wins, in the order the states are listed", () => {
    const everything = input({
      enabled: false,
      secretSet: false,
      lastError: { reason: "auth-failed", at: NOW - H },
      holdsOf: { scored: { code: "usage-spent", until: NOW + H } },
      read: read({ http: 401, classification: "auth-failed" }),
    });
    expect(credentialHealth(everything).health.state).toBe("disabled");
    expect(state({ ...everything, enabled: true })).toBe("secret-missing");
    expect(state({ ...everything, enabled: true, secretSet: true })).toBe("auth-failed");
    expect(state({ read: read({ http: 403, classification: "no-access" }), holdsOf: { scored: { code: "usage-spent", until: null } } })).toBe("no-access");
    // A balance charge reads overage even with the window it marked spent beside it.
    expect(state({ read: read({ classification: "overage" }), holdsOf: { scored: { code: "overage", until: null }, freeplay: { code: "usage-spent", until: null } } })).toBe("overage");
    expect(state({ read: read({ classification: "ok" }), holdsOf: { scored: { code: "usage-spent", until: null } } })).toBe("quota-spent");
    expect(state({ read: read({ classification: "overage" }), holdsOf: { scored: { code: "usage-threshold", until: null } } })).toBe("overage");
    expect(state({ read: read({ http: null, classification: "unread" }), holdsOf: { scored: { code: "runs-budget", until: null } } })).toBe("held");
    expect(state({ read: read({ http: null, classification: "unread" }) })).toBe("unread");
    expect(HEALTH_STATES.at(-1)).toBe("ok");
  });

  test("switched off and a missing secret: the fix is the switch, or the variable to set", () => {
    expect(credentialHealth(input({ enabled: false })).fix).toEqual({ kind: "enable", text: "enable it" });
    expect(credentialHealth(input({ secretSet: false }))).toMatchObject({
      health: { state: "secret-missing", reason: "OPENCODE_KEY not set" },
      fix: { kind: "set-secret", secretEnv: "OPENCODE_KEY" },
    });
    expect(credentialHealth(input({ holds: "home", secretEnv: "CODEX_HOME", secretSet: false })).health.reason).toBe("CODEX_HOME not set, or no such directory");
    // Not handed to the model pods is as missing as unset, whatever the supervisor's own environment holds.
    expect(credentialHealth(input({ deployed: false })).health).toMatchObject({ state: "secret-missing", reason: "OPENCODE_KEY not in the chart's modelKeys" });
    expect(state({ deployed: null })).toBe("ok");
  });

  test("auth: a refused read or a run paused auth-failed, since when it was first seen; the fix is a new secret", () => {
    const r = read({ http: 401, code: "api_key_expired", classification: "auth-failed", since: NOW - 6 * 24 * H });
    expect(credentialHealth(input({ read: r }))).toEqual({
      health: { state: "auth-failed", reason: "key rejected: HTTP 401 api_key_expired", since: NOW - 6 * 24 * H, lastCheck: { at: r.at, http: 401, code: "api_key_expired" } },
      fix: { kind: "replace-secret", secretEnv: "OPENCODE_KEY", text: "a new key in OPENCODE_KEY" },
    });
    const paused = credentialHealth(input({ holds: "token", secretEnv: "CLAUDE_CODE_OAUTH_TOKEN", lastError: { reason: "auth-failed", at: NOW - H } }));
    expect(paused.health).toMatchObject({ state: "auth-failed", reason: "a run paused: auth failed", since: NOW - H });
    expect(paused.fix?.text).toBe("a new token in CLAUDE_CODE_OAUTH_TOKEN");
    expect(state({ lastError: { reason: "rate-limited", at: NOW } })).toBe("ok");
  });

  test("spent: a window at 100%, the provider's word, or a run paused quota-exhausted; the fix is to wait for the reset", () => {
    expect(credentialHealth(input({ holdsOf: { scored: { code: "usage-spent", until: NOW + 2 * H }, freeplay: { code: "usage-spent", until: NOW + 3 * H } } }))).toMatchObject({
      health: { state: "quota-spent", reason: "a usage window is spent" },
      fix: { kind: "wait-reset", until: NOW + 3 * H },
    });
    expect(state({ read: read({ classification: "spent" }) })).toBe("quota-spent");
    expect(credentialHealth(input({ lastError: { reason: "quota-exhausted", at: NOW - H } })).health).toMatchObject({ state: "quota-spent", since: NOW - H });
  });

  test("held by the budget: what holds it and which classes, the fix to raise it or wait", () => {
    const threshold = credentialHealth(input({ holdsOf: { scored: { code: "usage-threshold", until: NOW + H } } }));
    expect(threshold).toMatchObject({ health: { state: "held", reason: "usage at its threshold (scored)" }, fix: { kind: "raise-budget", until: NOW + H } });
    const runs = credentialHealth(input({ holdsOf: { scored: { code: "runs-budget", until: NOW + 12 * H }, freeplay: { code: "runs-budget", until: NOW + 12 * H } } }));
    expect(runs.health.reason).toBe("today's runs are used");
    expect(runs.fix?.text).toBe("raise its budget, or wait for 00:00 UTC");
    // A supervisor that worded its holds only.
    expect(credentialHealth(input({ holdsOf: { freeplay: { code: null, until: null } } })).health.reason).toBe("held by its budget (freeplay)");
  });

  test("unread: the provider gave no answer, said with what it gave", () => {
    expect(credentialHealth(input({ read: read({ http: null, code: "TimeoutError", classification: "unread", since: NOW - H }) })).health).toEqual({
      state: "unread",
      reason: "usage not read: TimeoutError",
      since: NOW - H,
      lastCheck: { at: NOW - 60_000, http: null, code: "TimeoutError" },
    });
  });
});

describe("credentialWindows", () => {
  test("named by their length, spent ones limited, a reset in the past dropped", () => {
    const u = {
      credential: "go",
      observedAt: NOW - 60_000,
      windows: [
        { usedPercent: 12, windowMinutes: 300, resetsAt: NOW + H },
        { usedPercent: 100, windowMinutes: 7 * 1440, resetsAt: NOW + 48 * H, family: "opus" },
        { usedPercent: 20, windowMinutes: 30 * 1440, resetsAt: NOW + 200 * H },
        { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 1 },
      ],
    };
    expect(credentialWindows(u, NOW)).toEqual([
      { name: "5h", usedPercent: 12, resetsAt: NOW + H, limited: false },
      { name: "week", family: "opus", usedPercent: 100, resetsAt: NOW + 48 * H, limited: true },
      // The month's own reset, not the seven days a pause waits at most.
      { name: "month", usedPercent: 20, resetsAt: NOW + 200 * H, limited: false },
    ]);
    expect(credentialWindows(undefined, NOW)).toBeNull();
    expect([windowName(null), windowName(120), windowName(2 * 1440)]).toEqual(["window", "2h", "2d"]);
  });
});
