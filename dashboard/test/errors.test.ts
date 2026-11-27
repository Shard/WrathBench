import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/api/client";
import { SNAPSHOT_ERROR_TEXT, SNAPSHOT_RETRYING, errorText } from "../src/lib/errors";

describe("errorText", () => {
  test("the public build names neither the url nor the status", () => {
    const err = new Error("https://bucket.example/v1/snap/abc/runs.json: 404");
    const text = errorText(err, true);
    expect(text).toBe(`${SNAPSHOT_ERROR_TEXT}${SNAPSHOT_RETRYING}`);
    expect(text).not.toContain("bucket.example");
    expect(text).not.toContain("404");
    expect(text).not.toContain("/v1/");
    for (const status of [404, 403, 502]) {
      const api = errorText(new ApiError(status, `https://bucket.example/v1/snap/abc/runs/x.json: ${status}`), true);
      expect(api).not.toContain("bucket.example");
      expect(api).not.toContain(String(status));
    }
  });
});
