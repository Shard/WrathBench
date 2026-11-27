/**
 * Session tokens are the module's only authentication for `POST /action` and
 * `DELETE /session`. They used to default to the run id — a
 * second-granularity timestamp, enumerable from inside any concurrent run's
 * snippet — so these pin the two properties that replaced it: a fresh token is
 * a random secret, and a stored one too short for the module's `weak_token`
 * floor is regenerated rather than carried forward.
 */

import { describe, expect, test } from "bun:test";
import { loadRunConfig, newRunId, newSessionToken, resolveSessionToken } from "../src/config";
import { MIN_TOKEN_LENGTH } from "../src/session-token";
import { Trajectory, readMeta } from "../src/trajectory";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

describe("newSessionToken", () => {

  test("is random, not derived from the clock like the run id was", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSessionToken()));
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens.size).toBe(200);
    expect(tokens.has(newRunId())).toBe(false);
  });
});

describe("resolveSessionToken", () => {

  test("keeps a stored token that already clears the floor", () => {
    const stored = newSessionToken();
    expect(resolveSessionToken(stored)).toEqual({ token: stored, regenerated: false });
  });

  test("regenerates a pre-hardening run's token, which was its run id", () => {
    const weak = newRunId();
    expect(weak.length).toBeLessThan(MIN_TOKEN_LENGTH);
    const { token, regenerated } = resolveSessionToken(weak);
    expect(regenerated).toBe(true);
    expect(token).not.toBe(weak);
    expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
  });

});

describe("token persistence through meta.json", () => {
  test("a token round-trips, so --resume reattaches to the same session", () => {
    const dir = tempDir("wrathbench-token-");
    const traj = new Trajectory(dir);
    const token = newSessionToken();
    const config = loadRunConfig({ runId: "run-t", token, driver: "stub" });
    traj.writeMeta({ runId: "run-t", harnessVersion: "0.0.0-test", startedAt: 1, config });
    const meta = readMeta(dir);
    expect(meta?.config.token).toBe(token);
    // And the reload path run.ts takes on --resume keeps it intact.
    expect(loadRunConfig(meta!.config).token).toBe(token);
    expect(resolveSessionToken(loadRunConfig(meta!.config).token).regenerated).toBe(false);
    traj.close();
  });

});
