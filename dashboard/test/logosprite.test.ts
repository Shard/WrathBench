/**
 * The model-logo sprite (`src/lib/logosprite.ts`). The committed sprite must
 * be exactly what the committed per-family files make, since the badges draw
 * from one and the social card from the other; and it must hold a symbol for
 * every family the catalogue says has a logo, since a badge decides between
 * logo and monogram from the catalogue before the sprite has arrived.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAMILIES } from "../../infra/model-catalogue";
import { spriteOf, standaloneSvg, symbolId, symbolOf, symbolsOf } from "../src/lib/logosprite";

const ASSETS = fileURLToPath(new URL("../src/assets/model-logos/", import.meta.url));
const SPRITE = fileURLToPath(new URL("../src/assets/model-logos.svg", import.meta.url));

const committed = (): Map<string, string> =>
  new Map(readdirSync(ASSETS).filter((f) => f.endsWith(".svg")).map((f) => [f.slice(0, -".svg".length), readFileSync(ASSETS + f, "utf8")]));

describe("the committed sprite", () => {
  test("is what the committed logo files make (else: bun infra/fetch-model-logos.ts)", () => {
    expect(readFileSync(SPRITE, "utf8")).toBe(spriteOf(committed()));
  });

  test("has a symbol for every family with a logo, and none for any other", () => {
    const ids = [...symbolsOf(readFileSync(SPRITE, "utf8")).keys()].sort();
    expect(ids).toEqual(FAMILIES.filter((f) => f.icon !== undefined).map((f) => f.id).sort());
  });

  test("names no id twice, so a gradient or mask reference finds its own logo's", () => {
    const ids = [...readFileSync(SPRITE, "utf8").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("is hidden by size rather than display:none, which would switch off its gradients", () => {
    const root = /^<svg[^>]*>/.exec(readFileSync(SPRITE, "utf8"))![0];
    expect(root).not.toContain("display:none");
    expect(root).toContain("width:0;height:0");
  });
});

describe("spriteOf / symbolsOf", () => {
  const MONO = '<svg fill="currentColor" fill-rule="evenodd" height="1em" style="flex:none;line-height:1" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"></path></svg>';
  const COLOUR = '<svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg"><path d="M1 1h1v1H1z" fill="#123456"></path></svg>';

  test("a root's presentation attributes ride on a group; its size, style and namespace do not", () => {
    expect(symbolOf(MONO, "mono")).toEqual({ viewBox: "0 0 24 24", body: '<g fill="currentColor" fill-rule="evenodd"><path d="M0 0h1v1H0z"></path></g>' });
    expect(symbolOf(COLOUR, "colour")).toEqual({ viewBox: "0 0 24 24", body: '<path d="M1 1h1v1H1z" fill="#123456"></path>' });
  });

  test("round-trips, sorted by family, under the badge's symbol ids", () => {
    const sprite = spriteOf(new Map([["zeta", COLOUR], ["alpha", MONO]]));
    expect(sprite.indexOf(`id="${symbolId("alpha")}"`)).toBeLessThan(sprite.indexOf(`id="${symbolId("zeta")}"`));
    const back = symbolsOf(sprite);
    expect([...back.keys()]).toEqual(["alpha", "zeta"]);
    expect(back.get("zeta")).toEqual(symbolOf(COLOUR, "zeta"));
  });

  test("a standalone image keeps the logo's paint and box", () => {
    const svg = standaloneSvg(symbolOf(MONO, "mono"));
    expect(svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="currentColor" fill-rule="evenodd"><path d="M0 0h1v1H0z"></path></g></svg>');
  });

  test("anything but one svg element with a viewBox is refused, naming the logo", () => {
    expect(() => symbolOf("<g/>", "odd")).toThrow("odd");
    expect(() => symbolOf('<svg width="1"><path/></svg>', "boxless")).toThrow("boxless: no viewBox");
  });
});
