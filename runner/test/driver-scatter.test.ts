/**
 * The driver seam stays one seam: a driver or harness id written as a string
 * literal outside the registry (`src/drivers.ts`) and the adapters is a
 * branch on a driver's name, and those branches are what made adding a
 * harness touch eighteen files. A new one fails here; the fix is a field on
 * the registry entry, read by lookup (runner/README.md, "The driver
 * contract").
 *
 * Three ids are unambiguous anywhere (`claude-code`, `codex`, `pi`). The other four
 * are also ordinary words in this repository — `openai` is a platform label,
 * `stub` a wowhead mode in the shots rig, `wrathbench` a namespace and a
 * database name, `reference` the wiki — so they count only on a line that
 * also says driver or harness. Comments never count.
 *
 * `ALLOWED` holds what is left on purpose, with a count, so a second literal in
 * an allowed file fails as surely as the first one anywhere else. The
 * dashboard is outside the scan: it is a separate bundle that reads the wire
 * and cannot import the registry (vite.config.ts), and its harness colours
 * are presentation.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Where a driver branch could regrow: the runner, the viewer, the fleet. */
const SCOPES = ["runner/src", "runner/viewer", "infra"];

/** The registry and the adapters: the two places a driver's name belongs. */
const OWNERS = [
  "runner/src/drivers.ts",
  "runner/src/driver-adapters.ts",
  "runner/src/adapter.ts",
  "runner/src/adapter-shared.ts",
  "runner/src/adapter-claude.ts",
  "runner/src/adapter-codex.ts",
  "runner/src/adapter-pi.ts",
  "runner/src/pi-extension.ts",
  "runner/src/codex-usage.ts",
  "runner/src/codex-rollout.ts",
  "runner/src/reference/",
];

/** File → how many driver literals it keeps on purpose, and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "runner/src/prompt.ts": {
    count: 7,
    why: "model-facing: the context sentence is an exhaustive switch over Harness, so a new harness fails typecheck until its sentence is decided, and the prompt bytes are pinned",
  },
};

const UNAMBIGUOUS = new Set(["claude-code", "codex", "pi"]);
const CONTEXTUAL = new Set(["openai", "stub", "reference", "wrathbench"]);

/** A string literal's value and its line, comments and template substitutions excluded. */
interface Literal {
  value: string;
  line: number;
}

/**
 * The string literals of a TypeScript source and the source with every
 * comment blanked (newlines kept, so line numbers hold). A small lexer, not a
 * parser: strings, templates (with nested substitutions), comments and regex
 * literals, which is what it takes to never read a comment or a regex as code.
 */
function lex(src: string): { literals: Literal[]; code: string } {
  const literals: Literal[] = [];
  const out: string[] = [];
  let i = 0;
  let line = 1;
  // The last significant character outside strings and comments, to tell a
  // regex literal from a division.
  let prev = "";
  let prevWord = "";
  const braces: number[] = []; // template substitution depth markers
  let depth = 0;
  const push = (s: string): void => {
    out.push(s);
    for (const ch of s) if (ch === "\n") line++;
  };
  const blank = (s: string): void => push(s.replace(/[^\n]/g, " "));
  const readQuoted = (q: string): void => {
    const start = i;
    const startLine = line;
    i++;
    let value = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") {
        value += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (src[i] === "\n" && q !== "`") break;
      value += src[i];
      i++;
    }
    i++;
    literals.push({ value, line: startLine });
    push(src.slice(start, i));
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      readQuoted(c);
      prev = c;
      continue;
    }
    if (c === "`" || (c === "}" && braces.length > 0 && braces[braces.length - 1] === depth)) {
      // A template, or the rest of one after a substitution closes.
      if (c === "}") braces.pop();
      const start = i;
      const startLine = line;
      i++;
      let value = "";
      let substituted = c === "}";
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          value += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          i += 2;
          braces.push(depth);
          substituted = true;
          break;
        }
        value += src[i];
        i++;
      }
      const closed = src[i] === "`";
      if (closed) i++;
      if (!substituted && closed) literals.push({ value, line: startLine });
      push(src.slice(start, i));
      prev = "`";
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || ["return", "typeof", "case", "in", "of"].includes(prevWord))) {
      // A regex literal: to the closing slash outside a class.
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i]!)) i++;
      push(src.slice(start, i));
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      prevWord = src.slice(i, j);
      prev = "a";
      push(prevWord);
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = "";
    }
    push(c);
    i++;
  }
  return { literals, code: out.join("") };
}

/** The driver literals of one source: every unambiguous id, and a contextual one on a line that names a driver or harness. */
function driverLiterals(src: string): Literal[] {
  const { literals, code } = lex(src);
  const lines = code.split("\n");
  return literals.filter((l) => {
    if (UNAMBIGUOUS.has(l.value)) return true;
    if (!CONTEXTUAL.has(l.value)) return false;
    return /driver|harness/i.test(lines[l.line - 1] ?? "");
  });
}

function scannedFiles(): string[] {
  const out: string[] = [];
  for (const scope of SCOPES) {
    for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, scope) })) {
      const rel = `${scope}/${f}`;
      if (/(^|\/)(test|fixtures|node_modules)\//.test(rel) || /(\.test|\/fixture)\.tsx?$/.test(rel)) continue;
      if (OWNERS.some((o) => (o.endsWith("/") ? rel.startsWith(o) : rel === o))) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

describe("the driver seam", () => {
  test("the lexer reads code, never a comment, a regex or a substitution", () => {
    const src = [
      `// driver === "codex"`,
      `/* "claude-code" */ const a = "codex";`,
      "const b = `x ${\"claude-code\"} y`;",
      `const r = /codex/i.test(s); const d = 4 / 2 / 1;`,
      `const driver = e.driver ?? "openai";`,
      `const platform = "openai";`,
    ].join("\n");
    expect(driverLiterals(src).map((l) => `${l.line}:${l.value}`)).toEqual(["2:codex", "3:claude-code", "5:openai"]);
  });

  test("no driver id is written outside the registry and the adapters", () => {
    const found: string[] = [];
    for (const rel of scannedFiles()) {
      const hits = driverLiterals(readFileSync(join(ROOT, rel), "utf8"));
      const allowed = ALLOWED[rel];
      if (allowed !== undefined && hits.length === allowed.count) continue;
      if (hits.length === 0 && allowed === undefined) continue;
      const where = hits.map((h) => `${rel}:${h.line} "${h.value}"`);
      found.push(allowed !== undefined ? `${rel}: ${hits.length} driver literals, allowed ${allowed.count} (${allowed.why})` : where.join("\n"));
    }
    expect(found.join("\n")).toBe("");
  });

  test("every allowed file still exists and is still scanned", () => {
    const scanned = new Set(scannedFiles());
    expect(Object.keys(ALLOWED).filter((f) => !scanned.has(f))).toEqual([]);
  });
});

