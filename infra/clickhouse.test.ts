/**
 * The ClickHouse server drop-ins are one source of truth in two deployments.
 *
 * `infra/clickhouse/` is canonical: compose bind-mounts the files from there,
 * and the Helm chart carries a verbatim inline copy because `.Files.Get`
 * cannot reach outside the chart directory. This suite is what keeps the copy
 * honest — it reads both and fails on any drift. No helm, no docker, no
 * `data/`: it is three file reads.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const chart = join(here, "chart/wrathbench/templates/clickhouse.yaml");

const files = {
  "memory.xml": join(here, "clickhouse/config.d/memory.xml"),
  "logging.xml": join(here, "clickhouse/config.d/logging.xml"),
  "wrathbench-profile.xml": join(here, "clickhouse/users.d/wrathbench-profile.xml"),
} as const;

const defines = {
  "memory.xml": "wrathbench.clickhouse.memoryXml",
  "logging.xml": "wrathbench.clickhouse.loggingXml",
  "wrathbench-profile.xml": "wrathbench.clickhouse.profileXml",
} as const;

function defineBody(template: string, name: string): string {
  const open = `{{- define "${name}" -}}\n`;
  const start = template.indexOf(open);
  expect(start, `chart defines ${name}`).toBeGreaterThanOrEqual(0);
  const from = start + open.length;
  const end = template.indexOf("\n{{- end -}}\n", from);
  expect(end, `${name} is closed`).toBeGreaterThan(from);
  return template.slice(from, end) + "\n";
}

describe("clickhouse drop-ins", () => {
  const template = readFileSync(chart, "utf8");

  for (const [name, path] of Object.entries(files)) {
    test(`${name} is inlined in the chart verbatim`, () => {
      expect(defineBody(template, defines[name as keyof typeof defines])).toBe(
        readFileSync(path, "utf8"),
      );
    });

  }

  test("every drop-in is in the pod's config checksum", () => {
    // subPath mounts never hot-reload, so a drop-in the annotation does not
    // cover would change in the ConfigMap while the pod kept the old file.
    const line = template
      .split("\n")
      .find((l) => l.includes("checksum/clickhouse-config:"));
    expect(line, "the pod annotates a config checksum").toBeDefined();
    for (const name of Object.values(defines)) {
      expect(line!, `${name} is checksummed`).toContain(name);
    }
  });
});
