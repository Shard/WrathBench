/**
 * The driver registry (`src/drivers.ts`) and its adapter map
 * (`src/driver-adapters.ts`).
 *
 * The load-bearing claims: every derived list reads exactly as the scattered
 * literals it replaced did, in the same order (refusals print them and the
 * comparability schema is built from one), and the registry agrees with the
 * adapters — a scaffold runs its own episode, a fixed-loop driver does not.
 */

import { describe, expect, test } from "bun:test";
import { COMPACT_WINDOW_DRIVERS, compactWindowDriverRefusal, DRIVER_STAMPS, REFERENCE_STAMP, STUB_STAMP } from "../src/config";
import { DRIVER_ADAPTERS } from "../src/driver-adapters";
import {
  DEFAULT_DRIVER,
  DRIVER_LIST,
  DRIVER_POD_VOLUMES,
  DRIVER_TABLE,
  DRIVERS,
  entryOf,
  HARNESS_OF_DRIVER,
  HARNESSES,
  HOME_LANE_ENVS,
  PLACED_LANE_DRIVER,
  ROSTER_DRIVERS,
  harnessDriver,
  isProbeOnlyDriver,
  probeOnlyRefusal,
  type RosterDriver,
} from "../src/drivers";
import { CLAUDE_TOTAL_KEY, CONCURRENCY_KEYS } from "../src/models";

/** Compile-time: the roster's driver union is exactly these four. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const rosterUnion: Equal<RosterDriver, "openai" | "claude-code" | "codex" | "pi"> = true;

describe("the driver registry", () => {
  test("one entry per driver, keyed by its own id, in DRIVERS order", () => {
    expect(DRIVER_LIST.map((d) => d.id)).toEqual([...DRIVERS]);
    for (const d of DRIVERS) expect(DRIVER_TABLE[d].id).toBe(d);
    expect(rosterUnion).toBe(true);
  });

  test("the harness tags are the entries' harnesses, first seen first", () => {
    expect([...new Set(DRIVER_LIST.map((d) => d.harness))]).toEqual([...HARNESSES]);
    expect(HARNESS_OF_DRIVER).toEqual({
      openai: "wrathbench",
      "claude-code": "claude-code",
      codex: "codex",
      pi: "pi",
      stub: "wrathbench",
      reference: "wrathbench",
    });
    expect(harnessDriver("pi")?.id).toBe("pi");
    expect(harnessDriver("wrathbench")?.id).toBe("openai");
    expect(harnessDriver("openai")).toBeUndefined();
  });

  test("the derived vocabularies read as the literals they replaced", () => {
    expect(DEFAULT_DRIVER).toBe("openai");
    expect(ROSTER_DRIVERS).toEqual(["openai", "claude-code", "codex", "pi"]);
    expect(COMPACT_WINDOW_DRIVERS).toEqual(["claude-code", "codex", "pi"]);
    expect(compactWindowDriverRefusal("openai")).toBe(
      "compactWindow is a CLI harness's auto-compaction window (claude-code, codex, pi) — the openai driver has none",
    );
    expect(CONCURRENCY_KEYS.slice(0, 5)).toEqual(["openai", "claude-code", "codex", "pi", "stub"]);
    expect(CLAUDE_TOTAL_KEY).toBe("claude-code");
    expect(PLACED_LANE_DRIVER).toBe("claude-code");
    expect(DRIVER_STAMPS).toEqual({ stub: STUB_STAMP, reference: REFERENCE_STAMP });
    expect(DRIVER_POD_VOLUMES).toEqual(["codex-home"]);
    expect(HOME_LANE_ENVS).toEqual(["CODEX_HOME"]);
  });

  test("a scaffold runs its own episode; a fixed-loop driver hands runLoop an adapter", () => {
    for (const d of DRIVER_LIST) {
      expect({ id: d.id, runsEpisode: DRIVER_ADAPTERS[d.id].runEpisode !== undefined }).toEqual({ id: d.id, runsEpisode: d.kind === "scaffold" });
    }
  });

  test("the facts hang together", () => {
    // One driver places runs among lanes; its lane key is its id, which is the
    // concurrency key every one of its sessions counts against.
    expect(DRIVER_LIST.filter((d) => d.lane?.placed === true).map((d) => d.id)).toEqual([PLACED_LANE_DRIVER]);
    for (const d of DRIVER_LIST) {
      // A lane is a subscription's, and only a subscription has one.
      expect({ id: d.id, lane: d.lane !== undefined }).toEqual({ id: d.id, lane: d.bill === "subscription" });
      if (d.lane !== undefined) expect(d.lane.key).toBe(d.id);
      // An endpoint driver is never a subscription; a driver that is not a model is never on the roster.
      if (d.endpoint) expect(d.bill).toBe("metered");
      if (d.stamp !== undefined) expect(d.roster).toBe(false);
      // A home lane's directory is mounted, so its driver names the volume.
      if (d.lane?.holds === "home") expect(d.podVolumes.length).toBeGreaterThan(0);
    }
  });

  test("pi: a metered scaffold on an endpoint, without OpenRouter routing, and probe-only", () => {
    const pi = entryOf("pi");
    expect({ harness: pi.harness, kind: pi.kind, endpoint: pi.endpoint, routing: pi.routing, bill: pi.bill, lane: pi.lane }).toEqual({
      harness: "pi",
      kind: "scaffold",
      endpoint: true,
      routing: false,
      bill: "metered",
      lane: undefined,
    });
    // Token-priced from the hand-held provider rows; pi's own figure is a cross-check only.
    expect(pi.cost).toEqual({ reported: "none", table: "synced" });
    expect({ compactWindow: pi.compactWindow, usage: pi.usage, rollouts: pi.rollouts, podVolumes: pi.podVolumes }).toEqual({
      compactWindow: true,
      usage: "response",
      rollouts: false,
      podVolumes: [],
    });
    // The operator's decision (2026-10-20): probe-only until promoted, and nothing else is.
    expect(DRIVER_LIST.filter((d) => d.probeOnly).map((d) => d.id)).toEqual(["pi"]);
    expect(isProbeOnlyDriver("pi")).toBe(true);
    expect(isProbeOnlyDriver(undefined)).toBe(false);
    expect(probeOnlyRefusal("pi")).toContain("probe-only");
    // Routing is the fixed loop's alone: it builds its own request body.
    expect(DRIVER_LIST.filter((d) => d.routing).map((d) => d.id)).toEqual(["openai"]);
    // Its CLI's own provider, named on the key's row: the roster refuses a key without one.
    expect(DRIVER_LIST.filter((d) => d.cliProvider === true).map((d) => d.id)).toEqual(["pi"]);
  });

  test("the lane wording the fleet prints is unchanged", () => {
    expect(entryOf("claude-code").lane!.describe(undefined)).toBe("claude CLI subscription");
    expect(entryOf("codex").lane!.describe(undefined)).toBe("codex CLI subscription, lane CODEX_HOME");
    expect(entryOf("codex").lane!.describe("CODEX_HOME_2")).toBe("codex CLI subscription, lane CODEX_HOME_2");
    expect(entryOf("claude-code").lane!.containerRefusal("CLAUDE_CODE_OAUTH_TOKEN_2")).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN_2 is not visible to the fleet container — put it in /wrathbench/.env (`claude setup-token`), it is loaded by Bun there and never passed via argv",
    );
    expect(entryOf("codex").lane!.containerRefusal("CODEX_HOME")).toBe(
      "CODEX_HOME is not visible to the fleet container — put it in /wrathbench/.env as the path of a logged-in Codex home (`codex login`); it is loaded by Bun there and never passed via argv",
    );
  });
});
