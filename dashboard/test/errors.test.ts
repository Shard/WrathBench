import { describe, expect, test } from "bun:test";
import { SNAPSHOT_ERROR_TEXT, errorText } from "../src/lib/errors";

describe("errorText", () => {
  test("the private build shows the operator the url and status", () => {
    const err = new Error("/api/runs: 502");
    expect(errorText(err, false)).toContain("/api/runs");
    expect(errorText(err, false)).toContain("502");
  });

  test("the public build names neither the url nor the status", () => {
    const err = new Error("https://bucket.example/v1/snap/abc/runs.json: 404");
    const text = errorText(err, true);
    expect(text).toBe(SNAPSHOT_ERROR_TEXT);
    expect(text).not.toContain("bucket.example");
    expect(text).not.toContain("404");
    expect(text).not.toContain("/v1/");
  });

  test("a non-Error rejection is still readable in both builds", () => {
    expect(errorText("boom", false)).toBe("boom");
    expect(errorText("boom", true)).toBe(SNAPSHOT_ERROR_TEXT);
  });
});
