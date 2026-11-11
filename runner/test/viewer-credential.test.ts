/**
 * What paid for a run, as the viewer reads it (#429): a v1 run records the
 * credential it took a slot on; a 0.5 run recorded the subscription lane it
 * billed, which v1 never writes and still reads. Both stay operator-only.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { comparabilityOf } from "../src/comparability";
import { loadRunConfig, newSessionToken } from "../src/config";
import { runCredentialOf } from "../src/credentials";
import { readRunFact } from "../src/models";
import { Trajectory } from "../src/trajectory";
import { createApi } from "../viewer/api";
import type { RunDetailResponse, RunsResponse } from "../viewer/api-types";
import { readRun } from "../viewer/runs";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** A run written by this build's own writer from a launch config, with one response. */
function writeRun(runsDir: string, runId: string, launch: Record<string, unknown>): void {
  const t = new Trajectory(join(runsDir, runId));
  const config = loadRunConfig({
    runId,
    token: newSessionToken(),
    driver: "claude-code",
    model: "sonnet",
    episode: "freeplay",
    runsDir,
    moduleUrl: "http://127.0.0.1:9",
    account: "RUNNER",
    ...launch,
  });
  t.writeMeta({ runId, harnessVersion: "harness-0.5-1", startedAt: Date.now() - 3_600_000, config, comparability: comparabilityOf(config, "harness-0.5-1") });
  t.append({ t: "response", text: "…" });
  t.close();
}

describe("a run's credential in the viewer", () => {
  test("a 0.5 run's lane still reads; a v1 run reads its credential; neither appears on a run that recorded none", async () => {
    const runsDir = tempDir("wb-viewer-credential-");
    // A 0.5 run on the second Claude subscription: its meta.json names the lane.
    writeRun(runsDir, "l05-lane", { subscription: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    // A v1 run placed on a credential.
    writeRun(runsDir, "v1-cred", { credential: "claude-2", credentialEnv: "CLAUDE_CODE_OAUTH_TOKEN_2", usageMaxPct: { scored: 80, freeplay: 80 } });
    // A run launched by hand: neither.
    writeRun(runsDir, "hand", {});

    expect(readRun(runsDir, "l05-lane")).toMatchObject({ model: "sonnet", lane: "CLAUDE_CODE_OAUTH_TOKEN_2" });
    expect(readRun(runsDir, "l05-lane").credential).toBeUndefined();
    expect(readRun(runsDir, "v1-cred")).toMatchObject({ credential: "claude-2" });
    expect(readRun(runsDir, "v1-cred").lane).toBeUndefined();
    expect("credential" in readRun(runsDir, "hand")).toBe(false);
    expect("lane" in readRun(runsDir, "hand")).toBe(false);

    // The scheduler reads the credential back off a v1 run; a 0.5 lane is no credential.
    expect(readRunFact(runsDir, "v1-cred")?.credential).toBe("claude-2");
    expect(readRunFact(runsDir, "l05-lane")?.credential).toBeNull();

    // Through the API: the private handle shows both, the public one neither.
    const priv = createApi({ runsDir, tilesDir: join(runsDir, "tiles") });
    const detail = (await (await priv(new Request("http://x/api/run/l05-lane"))).json()) as RunDetailResponse;
    expect(detail.run.lane).toBe("CLAUDE_CODE_OAUTH_TOKEN_2");
    const pub = createApi({ runsDir, tilesDir: join(runsDir, "tiles"), publicMode: true });
    const listing = await (await pub(new Request("http://x/api/runs"))).text();
    expect(listing).not.toContain("CLAUDE_CODE_OAUTH_TOKEN_2");
    expect(listing).not.toContain("claude-2");
    const rows = (JSON.parse(listing) as RunsResponse).runs;
    expect(rows.length).toBeGreaterThan(0);
  });

  test("runCredentialOf takes only what was recorded", () => {
    expect(runCredentialOf({ credential: "or-free" })).toEqual({ credential: "or-free" });
    expect(runCredentialOf({ subscription: "CODEX_HOME_2" })).toEqual({ lane: "CODEX_HOME_2" });
    expect(runCredentialOf({ credential: "", subscription: 3 })).toEqual({});
    expect(runCredentialOf(undefined)).toEqual({});
  });
});
