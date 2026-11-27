import { describe, expect, test } from "bun:test";
import { decodeBlp } from "../src/blp";
import {
  buildDxtBlp,
  buildPaletteBlp,
  buildRawBlp,
  dxt1Block,
  dxt5Block,
  rgb565of,
} from "./fixtures";

function pixel(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const o = (y * width + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]] as number[];
}

/** 565 quantisation is lossy; compare within one step of each channel. */
function expectClose(got: number[], want: number[], tolerance = 8): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs((got[i] ?? 0) - (want[i] ?? 0))).toBeLessThanOrEqual(tolerance);
  }
}

describe("palettised BLP2", () => {
  const palette = new Uint8Array(1024);
  // Entry 0 = red, entry 1 = green (palette entries are BGRA).
  palette.set([0, 0, 255, 255], 0);
  palette.set([0, 255, 0, 255], 4);

  test("decodes indices through the palette, opaque without an alpha plane, and applies an 8-bit one", () => {
    const indices = new Uint8Array([0, 1, 1, 0]);
    const img = decodeBlp(buildPaletteBlp(2, 2, palette, indices));
    expect(img.width).toBe(2);
    expect(pixel(img.rgba, 2, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(img.rgba, 2, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixel(img.rgba, 2, 0, 1)).toEqual([0, 255, 0, 255]);
    const alpha = new Uint8Array([0, 64, 128, 255]);
    const withAlpha = decodeBlp(buildPaletteBlp(2, 2, palette, indices, alpha));
    expect([0, 1, 2, 3].map((i) => withAlpha.rgba[i * 4 + 3])).toEqual([0, 64, 128, 255]);
  });

});

describe("raw BGRA BLP2", () => {
  test("swaps B and R", () => {
    const bgra = new Uint8Array([10, 20, 30, 40]);
    const img = decodeBlp(buildRawBlp(1, 1, bgra));
    expect(pixel(img.rgba, 1, 0, 0)).toEqual([30, 20, 10, 40]);
  });
});

describe("DXT BLP2", () => {
  const blue = rgb565of(0, 0, 255);
  const black = rgb565of(0, 0, 0);

  test("DXT5 reads the interpolated alpha half", () => {
    const img = decodeBlp(buildDxtBlp(4, 4, 5, dxt5Block(200, 10, blue, black)));
    expectClose(pixel(img.rgba, 4, 3, 3), [0, 0, 255, 200]);
  });

  test("handles a multi-block image", () => {
    const blocks = new Uint8Array(8 * 4); // 8x8 = 2x2 blocks, DXT1
    const red = rgb565of(255, 0, 0);
    const green = rgb565of(0, 255, 0);
    blocks.set(dxt1Block(red, black), 0);
    blocks.set(dxt1Block(green, black), 8);
    blocks.set(dxt1Block(green, black), 16);
    blocks.set(dxt1Block(red, black), 24);
    const img = decodeBlp(buildDxtBlp(8, 8, 1, blocks));
    expectClose(pixel(img.rgba, 8, 0, 0), [255, 0, 0, 255]);
    expectClose(pixel(img.rgba, 8, 4, 0), [0, 255, 0, 255]); // second block, top row
    expectClose(pixel(img.rgba, 8, 0, 4), [0, 255, 0, 255]); // third block, second row
    expectClose(pixel(img.rgba, 8, 4, 4), [255, 0, 0, 255]);
  });
});
