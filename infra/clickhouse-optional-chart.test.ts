/**
 * `clickhouse.enabled: false` renders a deployment that works without the
 * derived store: no ClickHouse or collector workload, and no CLICKHOUSE_*
 * variable on any pod. The viewer and the publisher choose their run store by
 * whether CLICKHOUSE_URL is set (runner/viewer/clickhouse.ts `storeFor`), so a
 * URL naming a Service the chart did not render would fail every listing, and
 * a CLICKHOUSE_PASSWORD reference would demand a Secret key nothing uses.
 * With it on (the default), the three readers still carry the coordinates.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];

type Container = { name: string; env?: { name: string }[] };
type Doc = { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: { containers?: Container[] } } } } | null;

function render(...extra: string[]): Doc[] {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc);
}

/** Workload name → the CLICKHOUSE_* variables its containers carry. */
function clickhouseVars(docs: Doc[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of docs) {
    const containers = d?.spec?.template?.spec?.containers;
    if (!containers || !d?.metadata?.name) continue;
    out[d.metadata.name] = containers.flatMap((c) => (c.env ?? []).map((e) => e.name)).filter((n) => n.startsWith("CLICKHOUSE_"));
  }
  return out;
}

describe.skipIf(helm === null)("the chart without ClickHouse", () => {
  test("off: no ClickHouse or collector workload, and no pod carries a CLICKHOUSE_* variable", () => {
    const docs = render("--set", "clickhouse.enabled=false");
    const names = docs.map((d) => d?.metadata?.name).filter(Boolean);
    expect(names).not.toContain("wrathbench-clickhouse");
    expect(names).not.toContain("wrathbench-collector");
    for (const [name, vars] of Object.entries(clickhouseVars(docs))) expect(vars, name).toEqual([]);
  }, HELM_TEST_MS);

  test("on: the viewer, publisher, runner and collector carry the store's coordinates", () => {
    const vars = clickhouseVars(render());
    for (const name of ["wrathbench-viewer", "wrathbench-publisher", "wrathbench-runner", "wrathbench-collector"]) {
      expect(vars[name], name).toContain("CLICKHOUSE_URL");
      expect(vars[name], name).toContain("CLICKHOUSE_PASSWORD");
    }
  }, HELM_TEST_MS);
});
