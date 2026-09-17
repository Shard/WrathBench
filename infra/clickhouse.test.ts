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

    test(`${name} is mounted as a FILE by both deployments`, () => {
      // A directory mount over config.d/users.d would make them read-only, and
      // the image's entrypoint writes users.d/default-user.xml at first boot to
      // create CLICKHOUSE_USER. compose bind-mounts the file; the chart uses
      // subPath, which is the same thing.
      const compose = readFileSync(join(here, "compose.yml"), "utf8");
      const rel = path.slice(here.length + 1);
      expect(compose).toContain(`./${rel}:/etc/clickhouse-server/`);
      expect(compose).toContain(`/${name}:ro`);
      expect(template).toContain(`subPath: ${name}`);
    });
  }

  test("XML comments carry no `--`, which ClickHouse refuses to parse", () => {
    // Learned the hard way: a stray `--replay` in a comment is a
    // SAXParseException at boot, not a warning.
    for (const path of Object.values(files)) {
      for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
        const body = line.replaceAll("<!--", "").replaceAll("-->", "");
        expect(body.includes("--"), `${path}:${i + 1}`).toBe(false);
      }
    }
  });

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

  test("the chart's memory limit leaves room for the bounded caches", () => {
    // The drop-ins declare ~512 MiB of cache plus a 512 MiB merge soft limit
    // plus 512 MiB per query; a 2Gi limit is what broke (Code: 241).
    const values = readFileSync(join(here, "chart/wrathbench/values.yaml"), "utf8");
    const block = values.slice(values.indexOf("\nclickhouse:"));
    expect(block).toContain("memory: 4Gi");
  });
});
