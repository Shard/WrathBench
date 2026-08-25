import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assetFile, iconPath, parseLineup, planAssets, readTar, selectIcons, type ModelLineup } from "./model-logos";

/**
 * The logo fetch is one network call away from being untestable, so everything
 * that decides anything lives in `model-logos.ts` and is exercised here against
 * a tarball built in-process. No network, no `data/`, no icon package.
 */

// ------------------------------------------------------------ tar fixtures

const enc = new TextEncoder();

/** One ustar header plus its padded body. `type` is the tar typeflag. */
function tarEntry(name: string, body: string, type = "0"): Uint8Array<ArrayBuffer> {
  const data = enc.encode(body);
  const header = new Uint8Array(512);
  const put = (off: number, s: string) => header.set(enc.encode(s), off);

  // Long paths split across the name (0..100) and prefix (345..500) fields.
  let nameField = name;
  let prefix = "";
  if (name.length > 100) {
    const cut = name.lastIndexOf("/", 100);
    prefix = name.slice(0, cut);
    nameField = name.slice(cut + 1);
  }
  put(0, nameField);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  put(345, prefix);
  // Checksum is computed with the field itself read as spaces.
  header.fill(32, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);

  const padded = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(512 + padded);
  out.set(header, 0);
  out.set(data, 512);
  return out;
}

function tar(...entries: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = entries.reduce((n, e) => n + e.length, 0) + 1024; // two zero blocks
  const out = new Uint8Array(total);
  let at = 0;
  for (const e of entries) {
    out.set(e, at);
    at += e.length;
  }
  return out;
}

const SVG_A = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M0 0h24v24H0z"/></svg>';
const SVG_B = '<svg viewBox="0 0 24 24"><path fill="#f00" d="M1 1h2v2H1z"/></svg>';

const ARCHIVE = tar(
  tarEntry("package/", "", "5"),
  tarEntry("package/package.json", '{"name":"@lobehub/icons-static-svg"}'),
  tarEntry(iconPath("alpha-color"), SVG_A),
  tarEntry(iconPath("beta"), SVG_B),
);

const LINEUP: ModelLineup = {
  version: 1,
  icons: { package: "@lobehub/icons-static-svg", version: "1.94.0" },
  families: [
    { id: "alpha", name: "Alpha", vendor: "A Co", icon: "alpha-color", match: ["a/*"] },
    { id: "beta", name: "Beta", vendor: "B Co", icon: "beta", match: ["b/*"] },
    { id: "plain", name: "Plain", vendor: "P Co", icon: undefined, match: ["p/*"] },
  ],
};

const text = (b: Uint8Array) => new TextDecoder().decode(b);

// ------------------------------------------------------------------- tests

describe("readTar", () => {
  test("regular files come back with their name and exact bytes", () => {
    const names = readTar(ARCHIVE).map((e) => e.name);
    expect(names).toEqual(["package/package.json", iconPath("alpha-color"), iconPath("beta")]);
    const alpha = readTar(ARCHIVE).find((e) => e.name === iconPath("alpha-color"))!;
    expect(text(alpha.data)).toBe(SVG_A);
  });

  test("a directory entry is skipped rather than returned as an empty file", () => {
    expect(readTar(ARCHIVE).some((e) => e.name === "package/")).toBe(false);
  });

  test("a path too long for the name field is rejoined from the prefix", () => {
    const long = `package/icons/${"nested/".repeat(15)}deep-icon.svg`;
    expect(long.length).toBeGreaterThan(100);
    const [entry] = readTar(tar(tarEntry(long, SVG_B)));
    expect(entry!.name).toBe(long);
    expect(text(entry!.data)).toBe(SVG_B);
  });

  test("it reads what the CLI actually reads: gzip in, entries out", () => {
    const round = readTar(new Uint8Array(Bun.gunzipSync(Bun.gzipSync(ARCHIVE))));
    expect(round.map((e) => e.name)).toEqual(readTar(ARCHIVE).map((e) => e.name));
  });

  test("trailing zero blocks end the archive, not an error", () => {
    expect(readTar(new Uint8Array(1024))).toEqual([]);
  });
});

describe("selectIcons", () => {
  test("one entry per family that names an icon, in lineup order", () => {
    const icons = selectIcons(LINEUP, readTar(ARCHIVE));
    expect(icons.map((i) => [i.familyId, i.slug])).toEqual([
      ["alpha", "alpha-color"],
      ["beta", "beta"],
    ]);
    expect(text(icons[0]!.svg)).toBe(SVG_A);
  });

  test("a slug the package does not carry is a hard error naming slug and family", () => {
    const typo: ModelLineup = { ...LINEUP, families: [{ id: "alpha", name: "Alpha", vendor: "A Co", icon: "alpha-colour", match: ["a/*"] }] };
    expect(() => selectIcons(typo, readTar(ARCHIVE))).toThrow(/family alpha.*alpha-colour/);
  });

  test("the packaged <title> is stripped so the badge's own tooltip wins", () => {
    const titled = '<svg viewBox="0 0 24 24"><title>Alpha</title><path d="M0 0h1v1H0z"/></svg>';
    const archive = tar(tarEntry(iconPath("alpha-color"), titled), tarEntry(iconPath("beta"), SVG_B));
    const [alpha] = selectIcons(LINEUP, readTar(archive));
    expect(text(alpha!.svg)).toBe('<svg viewBox="0 0 24 24"><path d="M0 0h1v1H0z"/></svg>');
  });
});

describe("planAssets", () => {
  const wanted = new Map<string, Uint8Array | null>([
    ["alpha", enc.encode(SVG_A)],
    ["beta", enc.encode(SVG_B)],
  ]);

  test("nothing on disk means everything is missing", () => {
    expect(planAssets(wanted, new Map())).toMatchObject({ missing: ["alpha", "beta"], stale: [], unchanged: [], orphaned: [] });
  });

  test("identical bytes are unchanged, different bytes are stale", () => {
    const present = new Map<string, Uint8Array | null>([
      ["alpha.svg", enc.encode(SVG_A)],
      ["beta.svg", enc.encode(`${SVG_B}\n`)],
    ]);
    expect(planAssets(wanted, present)).toMatchObject({ missing: [], stale: ["beta"], unchanged: ["alpha"] });
  });

  test("an svg no family references is orphaned; other files are left alone", () => {
    const present = new Map<string, Uint8Array | null>([
      ["alpha.svg", enc.encode(SVG_A)],
      ["beta.svg", enc.encode(SVG_B)],
      ["gamma.svg", enc.encode(SVG_A)],
      ["README.md", enc.encode("x")],
    ]);
    expect(planAssets(wanted, present).orphaned).toEqual(["gamma.svg"]);
  });

  test("--check reads no bytes, so a present file counts as unchanged, never stale", () => {
    const unread = new Map<string, Uint8Array | null>([["alpha", null], ["beta", null]]);
    const present = new Map<string, Uint8Array | null>([["alpha.svg", null]]);
    expect(planAssets(unread, present)).toMatchObject({ missing: ["beta"], stale: [], unchanged: ["alpha"] });
  });

  test("the filename is the family id", () => {
    expect(assetFile("deepseek")).toBe("deepseek.svg");
  });
});

describe("parseLineup", () => {
  const json = JSON.stringify({
    version: 1,
    icons: { package: "@lobehub/icons-static-svg", version: "1.94.0" },
    families: [{ id: "claude", name: "Claude", vendor: "Anthropic", icon: "claude-color", match: ["anthropic/*"] }],
  });

  test("a well-formed lineup round-trips", () => {
    const lineup = parseLineup(json);
    expect(lineup.icons).toEqual({ package: "@lobehub/icons-static-svg", version: "1.94.0" });
    expect(lineup.families[0]).toMatchObject({ id: "claude", vendor: "Anthropic", icon: "claude-color" });
  });

  test("the committed lineup parses, and every icon it names is a legal tarball path", () => {
    const lineup = parseLineup(readFileSync(`${import.meta.dir}/model-lineup.json`, "utf8"), "infra/model-lineup.json");
    expect(lineup.families.length).toBeGreaterThan(0);
    for (const f of lineup.families) if (f.icon !== undefined) expect(iconPath(f.icon)).toMatch(/^package\/icons\/[a-z0-9._-]+\.svg$/);
  });

  test("an icon-less family is allowed — it falls back to a monogram in the UI", () => {
    const lineup = parseLineup(json.replace('"icon":"claude-color",', ""));
    expect(lineup.families[0]!.icon).toBeUndefined();
  });

  test("bad shapes are refused by name, not coerced", () => {
    expect(() => parseLineup("{oops")).toThrow(/not valid JSON/);
    expect(() => parseLineup(json.replace('"version":1', '"version":"1"'))).toThrow(/version must be a number/);
    expect(() => parseLineup(json.replace('"1.94.0"', '""'))).toThrow(/icons\.version/);
    expect(() => parseLineup(json.replace('"families":[', '"families":[],"unused":['))).toThrow(/families must be a non-empty array/);
    expect(() => parseLineup(json.replace('"vendor":"Anthropic",', ""))).toThrow(/family claude vendor/);
    expect(() => parseLineup(json.replace('"match":["anthropic/*"]', '"match":[]'))).toThrow(/family claude match/);
    expect(() => parseLineup(json.replace('"id":"claude"', '"id":"../escape"'))).toThrow(/must match/);
  });

  test("two families cannot share an id — they would write the same file", () => {
    const dup = JSON.parse(json) as { families: unknown[] };
    dup.families.push(JSON.parse(json).families[0]);
    expect(() => parseLineup(JSON.stringify(dup))).toThrow(/duplicate family id "claude"/);
  });
});
