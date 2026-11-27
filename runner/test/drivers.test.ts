/**
 * The driver registry (`src/drivers.ts`) and its adapter map
 * (`src/driver-adapters.ts`).
 *
 * The load-bearing claims: the harness tags runs are owned by, the registry
 * agreeing with the adapters (a scaffold runs its own episode, a fixed-loop
 * driver does not), which drivers carry the unscored stamp and which are
 * probe-only, and the codex lane's run-pod refusal.
 */

import { describe, expect, test } from "bun:test";
import { DRIVER_STAMPS } from "../src/config";
import { REFERENCE_STAMP, STUB_STAMP, DRIVER_LIST, entryOf, HARNESS_OF_DRIVER, HARNESSES, inProcessRunPodRefusal, RUN_POD_STAMP_ENV, harnessDriver, isProbeOnlyDriver, probeOnlyRefusal } from "../src/drivers";
import { DRIVER_ADAPTERS } from "../src/driver-adapters";
import { providerOfModel } from "../src/credential-slots";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./fixtures/temp-dirs";

describe("the driver registry", () => {
  test("the harness tags are the entries' harnesses, first seen first", () => {
    expect([...new Set(DRIVER_LIST.map((d) => d.harness))]).toEqual([...HARNESSES]);
    expect(HARNESS_OF_DRIVER).toEqual({
      openai: "wrathbench",
      "claude-code": "claude-code",
      codex: "codex",
      pi: "pi",
      stub: "wrathbench",
      external: "external",
      reference: "wrathbench",
    });
    expect(harnessDriver("pi")?.id).toBe("pi");
    expect(harnessDriver("wrathbench")?.id).toBe("openai");
    expect(harnessDriver("openai")).toBeUndefined();
  });

  test("a scaffold runs its own episode; a fixed-loop driver hands runLoop an adapter", () => {
    for (const d of DRIVER_LIST) {
      expect({ id: d.id, runsEpisode: DRIVER_ADAPTERS[d.id].runEpisode !== undefined }).toEqual({ id: d.id, runsEpisode: d.kind === "scaffold" });
    }
  });

  test("the scripted drivers carry the unscored stamp, and only they do", () => {
    expect(DRIVER_STAMPS).toEqual({ stub: STUB_STAMP, reference: REFERENCE_STAMP });
  });

  test("the facts hang together", () => {
    for (const d of DRIVER_LIST) {
      // A CLI credential is a subscription's, and only a subscription has one;
      // it names the credential provider the driver's runs are served through.
      expect({ id: d.id, credential: d.credential !== undefined }).toEqual({ id: d.id, credential: d.bill === "subscription" });
      if (d.credential !== undefined) expect(providerOfModel({ driver: d.id })).not.toBeNull();
      // An endpoint driver is never a subscription; a driver that is not a model is never on the roster.
      if (d.endpoint) expect(d.bill).toBe("metered");
      if (d.stamp !== undefined) expect(d.roster).toBe(false);
      // A home credential's directory is mounted, so its driver names the volume.
      if (d.credential?.holds === "home") expect(d.podVolumes.length).toBeGreaterThan(0);
    }
  });

  test("pi: a metered scaffold on an endpoint, without OpenRouter routing, and probe-only", () => {
    const pi = entryOf("pi");
    expect({ harness: pi.harness, kind: pi.kind, endpoint: pi.endpoint, routing: pi.routing, bill: pi.bill, credential: pi.credential }).toEqual({
      harness: "pi",
      kind: "scaffold",
      endpoint: true,
      routing: false,
      bill: "metered",
      credential: undefined,
    });
    // Token-priced from the hand-held provider rows; pi's own figure is a cross-check only.
    expect(pi.cost).toEqual({ reported: "none", table: "synced" });
    expect({ compactWindow: pi.compactWindow, usage: pi.usage, rollouts: pi.rollouts, podVolumes: pi.podVolumes }).toEqual({
      compactWindow: true,
      usage: "response",
      rollouts: false,
      podVolumes: [],
    });
    // The operator's decisions: pi probe-only until promoted (2026-10-20), and
    // an external agent probe-only in v1 (2026-11-14); nothing else is.
    expect(DRIVER_LIST.filter((d) => d.probeOnly).map((d) => d.id)).toEqual(["pi", "external"]);
    expect(isProbeOnlyDriver("pi")).toBe(true);
    expect(isProbeOnlyDriver(undefined)).toBe(false);
    expect(probeOnlyRefusal("pi")).toContain("probe-only");
    // Routing is the fixed loop's alone: it builds its own request body.
    expect(DRIVER_LIST.filter((d) => d.routing).map((d) => d.id)).toEqual(["openai"]);
    // Its CLI's own provider, named on the key's row: the roster refuses a key without one.
    expect(DRIVER_LIST.filter((d) => d.cliProvider === true).map((d) => d.id)).toEqual(["pi"]);
  });
});

describe("a runPod driver on the cluster runs in a run pod or not at all", () => {
  const CLUSTER = { KUBERNETES_SERVICE_HOST: "10.43.0.1" };

  test("codex is refused in any other process on the cluster, naming the supported path; off the cluster, or in a run pod, it is not", () => {
    expect(inProcessRunPodRefusal("codex", CLUSTER)).toContain("launch it through a roster or campaign entry, which the fleet runs in a run pod");
    expect(inProcessRunPodRefusal("codex", { ...CLUSTER, [RUN_POD_STAMP_ENV]: "1" })).toBeNull();
    expect(inProcessRunPodRefusal("codex", { [RUN_POD_STAMP_ENV]: "0" })).toBeNull();
    expect(inProcessRunPodRefusal("codex", {})).toBeNull();
    expect(inProcessRunPodRefusal("codex", { ...CLUSTER, [RUN_POD_STAMP_ENV]: "0" })).not.toBeNull();
    for (const d of DRIVER_LIST.filter((e) => e.runPod !== true)) expect([d.id, inProcessRunPodRefusal(d.id, CLUSTER)]).toEqual([d.id, null]);
  });

  test("run.ts refuses a hand launch of codex on the cluster before it writes anything", () => {
    const runs = tempDirs()("wrathbench-codex-in-process-");
    const root = join(import.meta.dir, "..", "..");
    const p = Bun.spawnSync(["bun", join(root, "runner", "src", "run.ts"), "--driver", "codex", "--model", "gpt-6.1-sol", "--episode", "freeplay", "--account", "PROBE", "--runs-dir", runs], {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp", ...CLUSTER },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("[wrathbench] launch refused: on the cluster a codex episode runs only in a run pod of its own");
    expect(readdirSync(runs)).toEqual([]);
  }, 30_000);
});
