/**
 * The identity catalog's matcher.
 *
 * The cases are the roster as it actually stands (infra/fleet.json): the ids
 * the fleet runs, the `:free` billing suffixes they carry, and the stealth ids
 * no family claims. What is being pinned is that recognition is data — a family
 * edit moves these, a code branch never should.
 */

import { describe, expect, test } from "bun:test";
import { FAMILIES, familyOf, iconModels, monogramOf } from "../src/lib/lineup";

const idOf = (model: string | null | undefined): string | null => familyOf(model)?.id ?? null;

describe("the roster's ids", () => {
  test("a bare Claude alias and a vendor-prefixed id land on the same family", () => {
    expect(idOf("opus")).toBe("claude");
    expect(idOf("sonnet")).toBe("claude");
    expect(idOf("anthropic/claude-opus-4-1")).toBe("claude");
    // A dated id, which is what the claude-code harness's roster entries carry.
    expect(idOf("claude-haiku-4-5-20251001")).toBe("claude");
  });

  test("every other id the fleet runs finds its family", () => {
    expect(idOf("openai/gpt-5.6-luna")).toBe("openai");
    // An open-weights model under the vendor's prefix is still that vendor's mark.
    expect(idOf("openai/gpt-oss-120b")).toBe("openai");
    expect(idOf("google/gemini-3.7-flash")).toBe("gemini");
    expect(idOf("deepseek/deepseek-v4-flash-0731")).toBe("deepseek");
    expect(idOf("deepseek/deepseek-v4-pro-0813")).toBe("deepseek");
    expect(idOf("qwen/qwen3.8-27b")).toBe("qwen");
    expect(idOf("z-ai/glm-5.2:free")).toBe("glm");
    expect(idOf("z-ai/glm-5.3")).toBe("glm");
    expect(idOf("z-ai/glm-4.7-flash")).toBe("glm");
    expect(idOf("minimax/minimax-m3")).toBe("minimax");
    // ...and bare, the way an OpenCode Zen id names the same model.
    expect(idOf("minimax-m3")).toBe("minimax");
  });

  test("the billing suffix is stripped, not matched on", () => {
    expect(idOf("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("nvidia");
    expect(idOf("cohere/north-mini-code:free")).toBe("cohere");
    // The same model with and without the suffix is the same model.
    expect(idOf("poolside/laguna-s-2.1:free")).toBe("poolside");
    expect(idOf("poolside/laguna-s-2.1")).toBe("poolside");
    // …and a `-free` id is not a suffix at all: it matches on its own name.
    expect(idOf("laguna-s-2.1-free")).toBe("poolside");
  });

  test("an id no family claims is null — the UI's monogram, never a special case here", () => {
    expect(idOf("stealth/ox-alpha")).toBeNull();
    expect(idOf("hy3-free")).toBeNull();
    expect(idOf("muse-spark-1.2-contributor-free")).toBeNull();
    expect(idOf("x-preview-f-free")).toBeNull();
  });

  test("nothing at all is nothing: null, undefined, empty, blank", () => {
    expect(familyOf(null)).toBeNull();
    expect(familyOf(undefined)).toBeNull();
    expect(familyOf("")).toBeNull();
    expect(familyOf("   ")).toBeNull();
    expect(familyOf(":free")).toBeNull();
  });
});

describe("matching", () => {
  test("ids are compared lowercased", () => {
    expect(idOf("OpenAI/GPT-5.6-Luna")).toBe("openai");
    expect(idOf("NVIDIA/Nemotron-3-Ultra-550B-A55B:FREE")).toBe("nvidia");
  });

  test("a glob is anchored at both ends: a prefix pattern is not a substring search", () => {
    // `gpt*` claims what starts with gpt, not what merely contains it.
    expect(idOf("gpt-4o-mini")).toBe("openai");
    expect(idOf("acme/not-gpt-at-all")).toBeNull();
    // `openai/*` needs the separator, and needs something after it.
    expect(idOf("openai-router/thing")).toBeNull();
  });

  test("file order is the precedence: the first family that matches wins", () => {
    // deepseek/* is claimed by the deepseek family, which sits above qwen; a
    // pattern lower in the file cannot take an id an earlier one already has.
    const first = FAMILIES.findIndex((f) => f.id === "deepseek");
    const later = FAMILIES.findIndex((f) => f.id === "qwen");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(later);
    expect(idOf("deepseek/deepseek-v4-flash-0731")).toBe("deepseek");
    // And a family is returned whole, so the UI has a name and a vendor to show.
    expect(familyOf("opus")).toMatchObject({ id: "claude", name: "Claude", vendor: "Anthropic" });
  });

  test("every family in the catalog is well formed", () => {
    expect(FAMILIES.length).toBeGreaterThan(0);
    for (const f of FAMILIES) {
      expect(f.id).toMatch(/^[a-z0-9-]+$/);
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.vendor.length).toBeGreaterThan(0);
      expect(f.icon.length).toBeGreaterThan(0);
      expect(f.match.length).toBeGreaterThan(0);
      // Every pattern is a pattern for this family: a glob that fell into the
      // wrong entry would be invisible here otherwise.
      for (const pattern of f.match) expect(familyOf(pattern.replace(/\*/g, "x"))).toBe(f);
    }
  });
});

describe("the monogram", () => {
  test("the first alphanumeric, uppercased", () => {
    expect(monogramOf("stealth/ox-alpha")).toBe("S");
    expect(monogramOf("hy3-free")).toBe("H");
    expect(monogramOf("x-preview-f-free")).toBe("X");
    expect(monogramOf("-2-lane")).toBe("2");
  });

  test("nothing to letter is a question mark, never an empty badge", () => {
    expect(monogramOf("")).toBe("?");
    expect(monogramOf("  /-  ")).toBe("?");
  });
});

describe("a job's icons", () => {
  test("one icon per family: a rotation of two Claude models shows one Claude", () => {
    expect(iconModels(["opus", "sonnet"])).toEqual(["opus"]);
    expect(iconModels(["opus", "openai/gpt-5.6-luna", "google/gemini-3.7-flash"])).toEqual([
      "opus",
      "openai/gpt-5.6-luna",
    ]);
  });

  test("unmatched ids drop out as soon as anything is recognised", () => {
    expect(iconModels(["stealth/ox-alpha", "opus"])).toEqual(["opus"]);
  });

  test("a list nothing matches keeps its first ids, so their monograms still show", () => {
    expect(iconModels(["stealth/ox-alpha", "hy3-free", "x-preview-f-free"])).toEqual([
      "stealth/ox-alpha",
      "hy3-free",
    ]);
    expect(iconModels([])).toEqual([]);
  });
});
