import { describe, expect, test } from "bun:test";
import { ROBOTS_KEY, ROBOTS_TXT } from "./robots";

describe("the data hostname's robots.txt", () => {
  test("sits at the bucket root", () => {
    expect(ROBOTS_KEY).toBe("robots.txt");
  });

  test("opens the headline material and closes per-run detail", () => {
    const lines = ROBOTS_TXT.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(lines[0]).toBe("User-agent: *");
    expect(lines).toContain("Allow: /v1/snap/");
    expect(lines).toContain("Allow: /v1/manifest.json");
    expect(lines).toContain("Allow: /v1/live.json");
    expect(lines).toContain("Allow: /tiles/");
    expect(lines).toContain("Disallow: /v1/run/");
    expect(lines.filter((l) => l.startsWith("Disallow:"))).toEqual(["Disallow: /v1/run/"]);
  });

  test("states the content terms: no training", () => {
    expect(ROBOTS_TXT).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=no");
  });
});
