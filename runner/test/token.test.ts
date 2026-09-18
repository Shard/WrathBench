/**
 * Session tokens are the module's only authentication for `POST /action` and
 * `DELETE /session`. They used to default to the run id — a
 * second-granularity timestamp, enumerable from inside any concurrent run's
 * snippet — so these pin the two properties that replaced it: a fresh token is
 * a random secret, and a stored one too short for the module's `weak_token`
 * floor is regenerated rather than carried forward.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_TOKEN_LENGTH,
  loadRunConfig,
  newRunId,
  newSessionToken,
  resolveSessionToken,
} from "../src/config";
import { Trajectory, readMeta } from "../src/trajectory";

describe("newSessionToken", () => {
  test("is 32 hex characters", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
  });

  test("is random, not derived from the clock like the run id was", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSessionToken()));
    expect(tokens.size).toBe(200);
    expect(tokens.has(newRunId())).toBe(false);
  });
});

describe("resolveSessionToken", () => {
  test("generates one when nothing was stored", () => {
    const { token, regenerated } = resolveSessionToken(undefined);
    expect(regenerated).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

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

  test("a one-character-short token is still weak", () => {
    const short = "a".repeat(MIN_TOKEN_LENGTH - 1);
    expect(resolveSessionToken(short).regenerated).toBe(true);
    expect(resolveSessionToken("a".repeat(MIN_TOKEN_LENGTH)).regenerated).toBe(false);
  });
});

describe("token persistence through meta.json", () => {
  test("a token round-trips, so --resume reattaches to the same session", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-token-"));
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

  test("a regenerated token is persisted, so the next resume does not swap again", () => {
    // What run.ts does on resume when the stored token is a pre-hardening run
    // id: resolve, then re-write the loaded meta with only `config` replaced.
    const dir = mkdtempSync(join(tmpdir(), "wrathbench-token-"));
    const traj = new Trajectory(dir);
    const old = loadRunConfig({ runId: "run-old", token: "run-old", driver: "stub" });
    traj.writeMeta({ runId: "run-old", harnessVersion: "0.0.0-test", startedAt: 7, config: old });

    const stored = readMeta(dir)!;
    const resolved = resolveSessionToken(stored.config.token);
    expect(resolved.regenerated).toBe(true);
    traj.writeMeta({ ...stored, config: { ...stored.config, token: resolved.token } });

    const after = readMeta(dir);
    expect(after?.config.token).toBe(resolved.token);
    // Everything else about the run is untouched.
    expect(after?.startedAt).toBe(7);
    expect(after?.harnessVersion).toBe("0.0.0-test");
    expect(after?.config.character).toBe(old.character);
    // A second resume finds a strong token and leaves it alone.
    expect(resolveSessionToken(after!.config.token).regenerated).toBe(false);
    traj.close();
  });
});
