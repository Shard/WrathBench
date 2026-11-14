import { describe, expect, test } from "bun:test";
import { parseServing, parseServingLabels } from "../src/serving";
import { servingRefusal } from "../src/roster-refusal";
import { comparabilityOf, harnessOfRun, subjectOfConfig } from "../src/comparability";
import { isProbeOnlyDriver, isRosterDriver } from "../src/drivers";
import { contextSentence } from "../src/prompt";
import { entryOwnsRun } from "../src/models";
import { chartGroupOf, conditionKey, conditionOf } from "../viewer/condition";
import { loadRunConfig } from "../src/config";

const BUILD = { weights: "Qwen/Qwen3.8-27B-GGUF", quant: "Q4_K_M", runtime: "LM Studio" };
const LAN = "http://192.168.100.20:1234/v1";

describe("parseServing — a local build, as the roster states it", () => {
  test("exactly weights, quant and runtime, each a non-empty string, trimmed", () => {
    expect(parseServing({ weights: " Qwen/Qwen3.8-27B-GGUF ", quant: "Q4_K_M", runtime: "LM Studio" }, "x")).toEqual(BUILD);
    expect(() => parseServing({ weights: "a", quant: "" , runtime: "r" }, "x")).toThrow(/serving.quant/);
    expect(() => parseServing({ weights: "a", quant: "q" }, "x")).toThrow(/serving.runtime/);
    expect(() => parseServing("Q4", "x")).toThrow(/must be an object/);
  });

  test("the machine and the runtime version are labels, refused as keys by name", () => {
    expect(() => parseServing({ ...BUILD, machine: "box" }, "x")).toThrow(/servingLabels, never a key/);
    expect(parseServingLabels({ machine: "box", runtimeVersion: "0.4.1" }, "x")).toEqual({ machine: "box", runtimeVersion: "0.4.1" });
    expect(() => parseServingLabels({ ip: "10.0.0.1" }, "x")).toThrow(/unknown key `ip`/);
  });

  test("weights name a repository or a model, never a path on the operator's disk", () => {
    for (const path of ["/models/qwen.gguf", "~/lmstudio/q", "./q", "C:\\models\\q", "qwen-q4.gguf"]) {
      expect(() => parseServing({ ...BUILD, weights: path }, "x")).toThrow(/file path/);
    }
  });
});

describe("servingRefusal — a local entry states its build, a hosted one does not", () => {
  test("a local base without serving is refused; with it, admitted", () => {
    expect(servingRefusal({ model: "qwen/q", apiBase: LAN }, {})).toMatch(/states what it serves/);
    expect(servingRefusal({ model: "qwen/q", apiBase: LAN, serving: BUILD }, {})).toBeNull();
    expect(servingRefusal({ model: "qwen/q", apiBase: LAN, serving: { ...BUILD, weights: "/m.gguf" } }, {})).toMatch(/file path/);
  });

  test("a hosted entry carries none, and labels need a build", () => {
    expect(servingRefusal({ model: "qwen/qwen3.8-27b" }, {})).toBeNull();
    expect(servingRefusal({ model: "qwen/qwen3.8-27b", serving: BUILD }, {})).toMatch(/hosted/);
    expect(servingRefusal({ model: "sonnet", driver: "claude-code", serving: BUILD }, {})).toMatch(/hosted/);
    expect(servingRefusal({ model: "qwen/q", apiBase: LAN, servingLabels: { machine: "box" } }, {})).toMatch(/states what it serves/);
  });
});

describe("the tuple and the key", () => {
  const config = (extra: Record<string, unknown> = {}) =>
    loadRunConfig({ model: "qwen/q", driver: "openai", apiBase: LAN, episode: "e90", ...extra } as never);

  test("a stated build stamps serving and subject local, after every older field; a hosted run stamps neither", () => {
    const local = comparabilityOf(config({ serving: BUILD, servingLabels: { machine: "poison-machine-label" } }), "harness-0.5-1-gabc");
    expect(local.serving).toEqual(BUILD);
    expect(local.subject).toBe("local");
    expect(Object.keys(local).slice(-2)).toEqual(["serving", "subject"]);
    // The labels never reach the tuple.
    expect(JSON.stringify(local)).not.toContain("poison-machine-label");
    const hosted = comparabilityOf(config({ apiBase: undefined }), "harness-0.5-1-gabc");
    expect("serving" in hosted).toBe(false);
    expect("subject" in hosted).toBe(false);
    expect(subjectOfConfig({ serving: undefined, driver: "openai" })).toBe("hosted");
    expect(subjectOfConfig({ serving: undefined, driver: "external" })).toBe("external");
  });

  test("a local build and the hosted model of one id are two conditions, and two roster entries", () => {
    const facts = (tuple: Record<string, unknown> | null, platform: string | null) => ({ series: "0.5", episode: "e90", harness: "wrathbench", tuple, platform });
    expect(conditionKey(facts({ serving: BUILD, subject: "local" }, "local"))).not.toBe(conditionKey(facts(null, "openrouter")));
    expect(conditionKey(facts({ serving: BUILD, subject: "local" }, "local"))).not.toBe(conditionKey(facts({ serving: { ...BUILD, quant: "Q8_0" }, subject: "local" }, "local")));
    // A local run stamped before the key reads as local off its platform, never as hosted.
    expect(conditionOf(facts(null, "local"))).toMatchObject({ subject: "local" });
    expect(conditionOf(facts(null, "openrouter"))).toMatchObject({ subject: "hosted" });
    expect(conditionOf(facts({ serving: BUILD, subject: "local" }, "local")).serving).toEqual(BUILD);

    const hostedEntry = { model: "qwen/qwen3.8-27b" };
    const localEntry = { model: "qwen/qwen3.8-27b", serving: BUILD };
    const localRun = { model: "qwen/qwen3.8-27b", serving: BUILD };
    const hostedRun = { model: "qwen/qwen3.8-27b", serving: null };
    expect(entryOwnsRun(localEntry, localRun)).toBe(true);
    expect(entryOwnsRun(hostedEntry, localRun)).toBe(false);
    expect(entryOwnsRun(localEntry, hostedRun)).toBe(false);
    expect(entryOwnsRun(hostedEntry, hostedRun)).toBe(true);
    // A caller that does not know the run's build (no field) matches as before.
    expect(entryOwnsRun(localEntry, { model: "qwen/qwen3.8-27b" })).toBe(true);
  });
});

describe("the external harness — an agent loop that is not ours", () => {
  test("a hand-driven stdio run reads as external, with the agent its operator declared", () => {
    const config = loadRunConfig({ driver: "external", model: "some/model", agent: { name: "an-agent", version: "1.2" } });
    expect(harnessOfRun({ comparability: null, driver: config.driver })).toBe("external");
    expect(config.agent).toEqual({ name: "an-agent", version: "1.2" });
    // Undeclared fields are null, never a guess.
    expect(loadRunConfig({ driver: "external", agent: { name: null, version: null } }).agent).toEqual({ name: null, version: null });
  });

  test("its own chart group, probe-only, never a roster entry, and never launched here", () => {
    expect(chartGroupOf({ loop: "snippet", pinned: true, wiki: true, subject: "external" }).id).toBe("external");
    const facts = (agent: { name: string | null; version: string | null }) => ({ series: "0.5", episode: "probing", harness: "external", tuple: { agent, subject: "external" } });
    expect(conditionKey(facts({ name: "a", version: "1" }))).not.toBe(conditionKey(facts({ name: "a", version: "2" })));
    expect(conditionOf(facts({ name: "a", version: "1" })).subject).toBe("external");
    expect(isProbeOnlyDriver("external")).toBe(true);
    expect(isRosterDriver("external")).toBe(false);
    expect(() => contextSentence("external")).toThrow(/no prompt of ours/);
  });
});
