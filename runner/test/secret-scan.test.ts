/**
 * The public boundary's secret scanner (`runner/src/secret-scan.ts`): known
 * values by value in one pass whatever their number, credential shapes by one
 * regular expression, and a report that names rules and counts and never
 * carries what matched.
 *
 * Every credential-shaped string here is assembled at run time from a prefix
 * and filler, so the file itself holds nothing a secret scanner of its own
 * would flag.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeFindings, envSecrets, maskCredentialShapes, runTokenSecrets, SecretScanner, SHAPE_RULES } from "../src/secret-scan";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const hex = (n: number): string => [...crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
const alnum = (n: number): string => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z"[(i * 7) % 31]).join("");

/** One sample per shape rule, each built from parts. */
const SAMPLES: Record<string, string> = {
  "anthropic-key": ["sk", "ant", "oat01", alnum(40)].join("-"),
  "openrouter-key": ["sk", "or", "v1", hex(64)].join("-"),
  "sk-key": ["sk", hex(32)].join("-"),
  "cerebras-key": ["csk", alnum(40)].join("-"),
  jwt: [`ey${"J"}hbGciOiJIUzI1NiJ9`, `ey${"J"}zdWIiOiIxMjM0NTY3ODkwIn0`, alnum(43)].join("."),
  "aws-access-key": `${"AK"}IA${"ABCDEFGHIJKLMNOP"}`,
  "github-token": `gh${"p"}_${alnum(36)}`,
  "slack-token": `xo${"x"}b-${hex(12)}-${hex(24)}`,
  "private-key": `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
  bearer: `Bearer ${alnum(40)}`,
  "named-hex": `"token":"${hex(32)}"`,
};

describe("shape rules", () => {
  test("every rule has a sample, and each sample is found under its own rule", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(SHAPE_RULES.map((r) => r.name).sort());
    const scanner = new SecretScanner();
    for (const [rule, sample] of Object.entries(SAMPLES)) {
      const findings = scanner.scan(`{"text":"before ${sample} after"}`);
      expect([rule, findings]).toEqual([rule, [{ rule, count: 1 }]]);
    }
  });

  test("a finding never carries the matched text, and the log line is rules and counts", () => {
    const scanner = new SecretScanner([{ label: "S3_SECRET_ACCESS_KEY", value: "known-secret-value-0123456789" }]);
    const body = `${Object.values(SAMPLES).join(" | ")} | known-secret-value-0123456789`;
    const findings = scanner.scan(body);
    const text = JSON.stringify(findings) + describeFindings(findings);
    for (const sample of Object.values(SAMPLES)) expect(text.includes(sample)).toBe(false);
    expect(text.includes("known-secret-value")).toBe(false);
    expect(findings.find((f) => f.rule === "known:S3_SECRET_ACCESS_KEY")).toEqual({ rule: "known:S3_SECRET_ACCESS_KEY", count: 1 });
    expect(describeFindings([{ rule: "jwt", count: 2 }, { rule: "sk-key", count: 1 }])).toBe("jwt ×2, sk-key ×1");
  });

  test("maskCredentialShapes masks each shape in place and leaves the rest of the line", () => {
    expect(maskCredentialShapes(`401 for ${SAMPLES["bearer"]} and ${SAMPLES["sk-key"]}, retrying`)).toBe("401 for [masked] and [masked], retrying");
    expect(maskCredentialShapes("no credential here")).toBe("no credential here");
  });

  test("a prefix inside a longer token is not a key: base64url runs, slugs and words", () => {
    const scanner = new SecretScanner();
    // A long base64url blob contains `sk-` and `eyJ` sooner or later; mid-run they are not a token's start.
    const blob = `${alnum(30)}sk-${alnum(40)}${alnum(10)}eyJ${alnum(20)}.eyJ${alnum(20)}.${alnum(20)}`;
    expect(scanner.scan(`{"b64":"${blob}"}`)).toEqual([]);
    expect(scanner.scan('{"slug":"desk-lamp-of-the-ancients-and-more-text","run":"fleet-task-0123456789abcdef"}')).toEqual([]);
    // A content hash under an ordinary key is not a credential; under "token" or "secret" it is.
    expect(scanner.scan(`{"version":"${hex(64)}","gen":"${hex(32)}","sha":"${hex(40)}"}`)).toEqual([]);
    expect(scanner.scan(`{"WRATHBENCH_SECRET":"${hex(64)}"}`)).toEqual([{ rule: "named-hex", count: 1 }]);
    expect(scanner.scan(`token=${hex(32)}&x=1`)).toEqual([{ rule: "named-hex", count: 1 }]);
    // Nested JSON escapes the quotes; the rule still sees the key.
    expect(scanner.scan(JSON.stringify({ text: JSON.stringify({ token: hex(32) }) }))).toEqual([{ rule: "named-hex", count: 1 }]);
    // An AWS id must end where the id ends.
    expect(scanner.scan(`${"AK"}IA${"ABCDEFGHIJKLMNOPQRS"}`)).toEqual([]);
  });
});

describe("known values", () => {
  test("found by value among many, counted per occurrence, labelled by source", () => {
    const tokens = Array.from({ length: 2_000 }, () => hex(32));
    const scanner = new SecretScanner(tokens.map((value) => ({ label: "session-token", value })));
    expect(scanner.scan(`{"a":"${"x".repeat(10_000)}"}`)).toEqual([]);
    const body = `a ${tokens[1_234]} b ${tokens[7]} c ${tokens[1_234]}`;
    // Bare hex with no key word in front: only the known-value rule can see it.
    expect(scanner.scan(body)).toEqual([{ rule: "known:session-token", count: 3 }]);
  });

  test("matched in its JSON-escaped and URL-encoded spellings too", () => {
    const value = 'p@ss"word/with\\odd&chars';
    const scanner = new SecretScanner([{ label: "WRATHBENCH_DB_PASSWORD", value }]);
    expect(scanner.scan(JSON.stringify({ note: `the password is ${value}` }))).toEqual([{ rule: "known:WRATHBENCH_DB_PASSWORD", count: 1 }]);
    expect(scanner.scan(`https://example.invalid/?p=${encodeURIComponent(value)}`)).toEqual([{ rule: "known:WRATHBENCH_DB_PASSWORD", count: 1 }]);
  });

  test("a value shorter than the floor is never registered; setKnown replaces the set", () => {
    const scanner = new SecretScanner([{ label: "SHORT", value: "abc123" }]);
    expect(scanner.knownCount).toBe(0);
    expect(scanner.scan("abc123 abc123")).toEqual([]);
    scanner.setKnown([{ label: "A", value: "first-value-0123456789" }]);
    scanner.setKnown([{ label: "B", value: "second-value-0123456789" }]);
    expect(scanner.scan("first-value-0123456789 second-value-0123456789")).toEqual([{ rule: "known:B", count: 1 }]);
  });

  test("a value at the very start and the very end of the text is found", () => {
    const v = "edge-secret-0123456789abcdef";
    const scanner = new SecretScanner([{ label: "E", value: v }]);
    expect(scanner.scan(v)).toEqual([{ rule: "known:E", count: 1 }]);
    expect(scanner.scan(`x${v}`)).toEqual([{ rule: "known:E", count: 1 }]);
    expect(scanner.scan(`${v}x`)).toEqual([{ rule: "known:E", count: 1 }]);
    expect(scanner.scan(v.slice(0, -1))).toEqual([]);
  });
});

describe("where the known values come from", () => {
  test("envSecrets: credential names by value; paths, variable names and weak values by name only", () => {
    const strong = `${alnum(24)}${hex(8)}`;
    const { secrets, skipped } = envSecrets({
      OPENROUTER_KEY: strong,
      CLAUDE_CODE_OAUTH_TOKEN_2: `${strong}2`,
      S3_ACCESS_KEY_ID: hex(32),
      WRATHBENCH_MODULE_SECRET: hex(64),
      MYSQL_PWD: `${strong}3`,
      CLICKHOUSE_PASSWORD: "changeme",
      SSL_KEY_FILE: "/etc/ssl/private/key.pem",
      TOKEN_ENV: "CLAUDE_CODE_OAUTH_TOKEN_2",
      CLICKHOUSE_URL: `http://user:${strong}4@clickhouse:8123`,
      S3_BUCKET: "public-bucket",
      PWD: "/home/someone",
      PATH: "/usr/bin",
    });
    expect(secrets.map((s) => s.label).sort()).toEqual(
      ["CLAUDE_CODE_OAUTH_TOKEN_2", "CLICKHOUSE_URL (password)", "MYSQL_PWD", "OPENROUTER_KEY", "S3_ACCESS_KEY_ID", "WRATHBENCH_MODULE_SECRET"].sort(),
    );
    expect(skipped).toEqual(["CLICKHOUSE_PASSWORD", "SSL_KEY_FILE", "TOKEN_ENV"]);
  });

  test("runTokenSecrets: each run's strikable token from its meta.json, and nothing from a run without one", () => {
    const runs = tempDir("wrathbench-scan-runs-");
    const token = hex(32);
    mkdirSync(join(runs, "r1"));
    writeFileSync(join(runs, "r1", "meta.json"), JSON.stringify({ config: { token } }));
    mkdirSync(join(runs, "r2"));
    writeFileSync(join(runs, "r2", "meta.json"), JSON.stringify({ config: { token: "r2" } }));
    mkdirSync(join(runs, "r3"));
    writeFileSync(join(runs, "roster.json"), "{}");
    expect(runTokenSecrets(runs)).toEqual([{ label: "session-token", value: token }]);
    expect(runTokenSecrets(join(runs, "absent"))).toEqual([]);
  });
});
