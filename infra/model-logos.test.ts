import { describe, expect, test } from "bun:test";
import { FAMILIES } from "./model-catalogue";
import { assetFile, iconPath, planAssets, readTar, selectIcons, type LogoCatalogue } from "./model-logos";

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

const CATALOGUE: LogoCatalogue = {
  icons: { package: "@lobehub/icons-static-svg", version: "1.94.0" },
  // An icon-less family is allowed: it falls back to a monogram in the UI.
  families: [{ id: "alpha", icon: "alpha-color" }, { id: "beta", icon: "beta" }, { id: "plain" }],
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
  test("one entry per family that names an icon, in catalogue order", () => {
    const icons = selectIcons(CATALOGUE, readTar(ARCHIVE));
    expect(icons.map((i) => [i.familyId, i.slug])).toEqual([
      ["alpha", "alpha-color"],
      ["beta", "beta"],
    ]);
    expect(text(icons[0]!.svg)).toBe(SVG_A);
  });

  test("a slug the package does not carry is a hard error naming slug and family", () => {
    const typo: LogoCatalogue = { ...CATALOGUE, families: [{ id: "alpha", icon: "alpha-colour" }] };
    expect(() => selectIcons(typo, readTar(ARCHIVE))).toThrow(/family alpha.*alpha-colour/);
  });

  test("the packaged <title> is stripped so the badge's own tooltip wins", () => {
    const titled = '<svg viewBox="0 0 24 24"><title>Alpha</title><path d="M0 0h1v1H0z"/></svg>';
    const archive = tar(tarEntry(iconPath("alpha-color"), titled), tarEntry(iconPath("beta"), SVG_B));
    const [alpha] = selectIcons(CATALOGUE, readTar(archive));
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

describe("the committed catalogue", () => {
  test("every icon it names is a legal tarball path", () => {
    expect(FAMILIES.length).toBeGreaterThan(0);
    for (const f of FAMILIES) if (f.icon !== undefined) expect(iconPath(f.icon)).toMatch(/^package\/icons\/[a-z0-9._-]+\.svg$/);
  });
});
