/**
 * A fast secret scanner: the last check before anything leaves the lab.
 *
 * Two kinds of rule, both applied in time linear in the text and independent
 * of how many secrets are known:
 *
 *  - **Known values.** Every secret the caller can name — its own credentials
 *    from the environment, each run's session token from meta.json — is
 *    matched by value. A rolling hash over the text's eight-character windows
 *    (`MIN_SECRET_CHARS`, the shortest value ever registered) is checked
 *    against a bit filter of the values' first eight characters, and only a
 *    window the filter passes is compared in full, so a thousand run tokens
 *    cost one pass, not a thousand `indexOf`s over a megabyte body. A value is
 *    also matched in its JSON-escaped and URL-encoded spellings, the two ways a
 *    serialised body would carry one with punctuation in it.
 *  - **Shapes.** One combined regular expression, one pass, for credentials no
 *    caller knows the value of: provider keys by prefix (`sk-ant-`, `sk-or-`,
 *    `sk-`, `csk-`), JWTs and OAuth tokens, AWS access key ids, GitHub and
 *    Slack tokens, private-key headers, `Bearer` credentials, and 32 or more
 *    hex characters right after a word like "token", "secret" or "key" (the
 *    session token and the lease secret are hex). Each prefix rule must start
 *    at a boundary, so the same letters inside a long base64 run do not count.
 *
 * A finding names the rule and how often it matched, never the matched text:
 * the scanner's report is safe to log wherever the thing it guards is not.
 *
 * `SecretRedactor` (redact.ts) is the other half and deliberately separate:
 * it rewrites what the runner writes and what the model reads, by value only,
 * because a shape rule that misfired on game text would change what the model
 * saw. This file never rewrites anything; it answers whether a body may go.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET_CHARS } from "./redact";
import { strikableSessionToken } from "./session-token";

/** One rule's matches in one body. */
export interface ScanFinding {
  /** `known:<label>` for a known value (the label names its source, never the value), else the shape rule's name. */
  rule: string;
  count: number;
}

/** A value to match by value, and where it came from (an env var's name, or `session-token`). */
export interface KnownSecret {
  label: string;
  value: string;
}

/** Case-insensitive spelling of a lowercase word without the `i` flag, which would loosen every other rule. */
const ci = (word: string): string => [...word].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join("");

/** Not preceded by a character that could belong to the same token: a prefix rule starts a token. */
const START = "(?<![A-Za-z0-9_-])";

/**
 * The shape rules, in priority order: the first alternative that matches at a
 * position names the finding, so the narrower prefixes come before `sk-key`.
 */
export const SHAPE_RULES: readonly { name: string; source: string }[] = [
  { name: "anthropic-key", source: `${START}sk-ant-[A-Za-z0-9_-]{20,}` },
  { name: "openrouter-key", source: `${START}sk-or-[A-Za-z0-9_-]{20,}` },
  { name: "sk-key", source: `${START}sk-[A-Za-z0-9_-]{20,}` },
  { name: "cerebras-key", source: `${START}csk-[A-Za-z0-9]{20,}` },
  { name: "jwt", source: `${START}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*` },
  { name: "aws-access-key", source: `${START}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])` },
  { name: "github-token", source: `${START}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})` },
  { name: "slack-token", source: `${START}xox[abprs]-[A-Za-z0-9-]{10,}` },
  { name: "private-key", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----" },
  { name: "bearer", source: `${ci("bearer")}\\s+[A-Za-z0-9._~+/=-]{20,}` },
  {
    name: "named-hex",
    // The word, then at most six characters of quoting and assignment (a JSON
    // key's `":"`, a nested string's `\":\"`, `=`, `: `), then the hex.
    source: `(?:${["token", "secret", "key", "password", "passwd", "auth"].map(ci).join("|")})["'\\\\\\s:=]{0,6}[0-9a-fA-F]{32,}(?![0-9a-zA-Z])`,
  },
];

const SHAPES = new RegExp(SHAPE_RULES.map((r, i) => `(?<r${i}>${r.source})`).join("|"), "g");

/** Window width of the rolling hash: the shortest secret ever registered. */
const W = MIN_SECRET_CHARS;
/** Polynomial base (the 32-bit FNV prime); arithmetic is mod 2^32 via `Math.imul`. */
const BASE = 0x01000193;
/** BASE^(W-1) mod 2^32: the weight of the character leaving the window. */
const BASE_TOP = ((): number => {
  let p = 1;
  for (let i = 1; i < W; i++) p = Math.imul(p, BASE);
  return p;
})();
/** The bit filter: 2^20 bits, indexed by a hash's top twenty bits. */
const FILTER_SHIFT = 12;

function windowHash(s: string, from: number): number {
  let h = 0;
  for (let i = from; i < from + W; i++) h = (Math.imul(h, BASE) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/**
 * The spellings a serialised body could carry a value in: as written, JSON
 * escaped (a quote, a backslash, a control character), and URL-encoded.
 */
function spellings(value: string): string[] {
  const out = new Set([value]);
  out.add(JSON.stringify(value).slice(1, -1));
  try {
    out.add(encodeURIComponent(value));
  } catch {
    /* a lone surrogate has no URL spelling */
  }
  return [...out].filter((s) => s.length >= W);
}

export class SecretScanner {
  private filter = new Uint32Array(1 << (32 - FILTER_SHIFT - 5));
  private byAnchor = new Map<number, { spelling: string; label: string }[]>();
  private count = 0;

  constructor(known: Iterable<KnownSecret> = []) {
    this.setKnown(known);
  }

  /** Replace the known values. Shorter than `MIN_SECRET_CHARS` is ignored, as everywhere a secret is registered. */
  setKnown(known: Iterable<KnownSecret>): void {
    this.filter = new Uint32Array(1 << (32 - FILTER_SHIFT - 5));
    this.byAnchor = new Map();
    const seen = new Set<string>();
    for (const { label, value } of known) {
      if (value.length < MIN_SECRET_CHARS) continue;
      for (const s of spellings(value)) {
        if (seen.has(s)) continue;
        seen.add(s);
        const h = windowHash(s, 0);
        const bit = h >>> FILTER_SHIFT;
        this.filter[bit >>> 5]! |= 1 << (bit & 31);
        const list = this.byAnchor.get(h);
        if (list === undefined) this.byAnchor.set(h, [{ spelling: s, label }]);
        else list.push({ spelling: s, label });
      }
    }
    this.count = seen.size;
  }

  /** How many spellings are matched by value. */
  get knownCount(): number {
    return this.count;
  }

  /** Every rule that matched `text`, with its count, sorted by rule; empty when the text is clean. */
  scan(text: string): ScanFinding[] {
    const counts = new Map<string, number>();
    const bump = (rule: string): void => {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    };

    // Known values: one rolling pass.
    const n = text.length;
    if (this.byAnchor.size > 0 && n >= W) {
      const filter = this.filter;
      // `h` is the hash of text[at, at + W): the first window, then rolled.
      let h = windowHash(text, 0) | 0;
      for (let at = 0; ; at++) {
        const bit = (h >>> 0) >>> FILTER_SHIFT;
        if ((filter[bit >>> 5]! & (1 << (bit & 31))) !== 0) {
          const candidates = this.byAnchor.get(h >>> 0);
          if (candidates !== undefined) {
            for (const c of candidates) if (text.startsWith(c.spelling, at)) bump(`known:${c.label}`);
          }
        }
        const next = at + W;
        if (next >= n) break;
        h = (Math.imul(h - Math.imul(text.charCodeAt(at), BASE_TOP), BASE) + text.charCodeAt(next)) | 0;
      }
    }

    // Shapes: one regular-expression pass.
    SHAPES.lastIndex = 0;
    for (let m = SHAPES.exec(text); m !== null; m = SHAPES.exec(text)) {
      const groups = m.groups ?? {};
      const i = SHAPE_RULES.findIndex((_, k) => groups[`r${k}`] !== undefined);
      bump(SHAPE_RULES[i]?.name ?? "shape");
    }

    return [...counts].map(([rule, count]) => ({ rule, count })).sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  }
}

/**
 * `text` with every credential shape replaced by `mask`, for a line an
 * operator reads where the rest of the line is the point (a CLI's error).
 */
export function maskCredentialShapes(text: string, mask = "[masked]"): string {
  return text.replace(SHAPES, mask);
}

/** One line for a log: rules and counts, never a value. */
export function describeFindings(findings: readonly ScanFinding[]): string {
  return findings.map((f) => `${f.rule} ×${f.count}`).join(", ");
}

/** An environment variable whose value is a credential, by its name. */
const SECRET_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)|_PWD$|ACCESS_KEY|KEY_ID$/;

/**
 * Too weak to be worth matching: shorter than twenty characters and drawn
 * from one character class ("password", "changeme"). Such a value matches
 * ordinary text everywhere it appears, and anything that guessable is not a
 * secret the scanner can keep — it is a credential to rotate.
 */
function tooWeak(value: string): boolean {
  if (value.length >= 20) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  return classes < 2;
}

/**
 * The credentials in an environment, by name, and the password of any URL
 * that carries one. Values that are paths, other variables' names, or too
 * weak to match safely are left out and listed by name in `skipped`.
 */
export function envSecrets(env: Record<string, string | undefined>): { secrets: KnownSecret[]; skipped: string[] } {
  const secrets: KnownSecret[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length === 0) continue;
    if (SECRET_NAME.test(name)) {
      if (value.startsWith("/") || /^[A-Z][A-Z0-9_]*$/.test(value) || value.length < MIN_SECRET_CHARS || tooWeak(value)) skipped.push(name);
      else secrets.push({ label: name, value });
      continue;
    }
    if (!value.includes("@") || !value.includes("://")) continue;
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password.length >= MIN_SECRET_CHARS && !tooWeak(password)) secrets.push({ label: `${name} (password)`, value: password });
      else if (password.length > 0) skipped.push(`${name} (password)`);
    } catch {
      /* not a URL */
    }
  }
  return { secrets, skipped: skipped.sort() };
}

/**
 * Every run's session token in a runs directory, read fresh from each run's
 * meta.json (`strikableSessionToken`, the same reading the public strike uses).
 */
export function runTokenSecrets(runsDir: string): KnownSecret[] {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: KnownSecret[] = [];
  for (const runId of names) {
    const token = strikableSessionToken(join(runsDir, runId), runId);
    if (token !== null) out.push({ label: "session-token", value: token });
  }
  return out;
}
