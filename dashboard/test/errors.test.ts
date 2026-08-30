import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/client";
import {
  SNAPSHOT_ERROR_TEXT,
  SNAPSHOT_MISSING_TEXT,
  SNAPSHOT_RETRYING,
  SNAPSHOT_WITHHELD_TEXT,
  errorText,
} from "../src/lib/errors";

describe("errorText", () => {
  test("the private build shows the operator the url and status", () => {
    const err = new Error("/api/runs: 502");
    expect(errorText(err, false)).toContain("/api/runs");
    expect(errorText(err, false)).toContain("502");
  });

  test("the public build names neither the url nor the status", () => {
    const err = new Error("https://bucket.example/v1/snap/abc/runs.json: 404");
    const text = errorText(err, true);
    expect(text).toBe(`${SNAPSHOT_ERROR_TEXT}${SNAPSHOT_RETRYING}`);
    expect(text).not.toContain("bucket.example");
    expect(text).not.toContain("404");
    expect(text).not.toContain("/v1/");
  });

  test("a non-Error rejection is still readable in both builds", () => {
    expect(errorText("boom", false)).toBe("boom");
    expect(errorText("boom", true)).toBe(`${SNAPSHOT_ERROR_TEXT}${SNAPSHOT_RETRYING}`);
  });

  test("the public build tells a missing run from a withheld route from a refresh, and promises a retry only when one happens", () => {
    const missing = new ApiError(404, "https://bucket.example/v1/snap/abc/runs/x.json: 404");
    expect(errorText(missing, true)).toBe(SNAPSHOT_MISSING_TEXT);
    expect(errorText(missing, true)).not.toContain("retry");
    expect(errorText(new ApiError(403, "raw: withheld"), true)).toBe(SNAPSHOT_WITHHELD_TEXT);
    const flaky = new ApiError(502, "https://bucket.example/v1/manifest.json: 502");
    expect(errorText(flaky, true, false)).toBe(`${SNAPSHOT_ERROR_TEXT}.`);
    expect(errorText(flaky, true, false)).not.toContain("retry");
    expect(errorText(flaky, true, true)).toContain("retrying");
    // Privately the status is the whole point, whatever it is.
    expect(errorText(missing, false)).toContain("404");
  });
});
