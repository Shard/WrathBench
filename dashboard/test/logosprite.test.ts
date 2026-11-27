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
import { spriteOf, symbolsOf } from "../src/lib/logosprite";

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
});
