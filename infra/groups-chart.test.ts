/**
 * The chart's groups and admin switch (runner/viewer/groups.ts, values.yaml
 * "groups" and "admin"): a group that is off renders none of its workloads and
 * tells the pods that remain through WRATHBENCH_GROUPS, and every group on
 * renders exactly what the chart rendered before groups existed — no
 * WRATHBENCH_GROUPS anywhere, and no WRATHBENCH_ADMIN until admin is on.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];

type Container = { name: string; env?: { name: string; value?: string }[] };
type Doc = { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: { containers?: Container[] } } } } | null;

function run(...extra: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function render(...extra: string[]): Doc[] {
  const r = run(...extra);
  expect(r.code, r.err).toBe(0);
  return r.out.split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc);
}

const names = (docs: Doc[]): string[] => [...new Set(docs.map((d) => d?.metadata?.name).filter((n): n is string => typeof n === "string"))];

/** Workload name -> the value of one variable on its containers, or undefined. */
function envOf(docs: Doc[], variable: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const d of docs) {
    const containers = d?.spec?.template?.spec?.containers;
    if (!containers || !d?.metadata?.name) continue;
    out[d.metadata.name] = containers.flatMap((c) => c.env ?? []).find((e) => e.name === variable)?.value;
  }
  return out;
}

const RUNNER_WORKLOADS = ["wrathbench-fleet", "wrathbench-runner", "wrathbench-run-pods", "wrathbench-run-pod-template", "wrathbench-codex-home"];
const VIEWER_WORKLOADS = ["wrathbench-viewer", "wrathbench-publisher", "wrathbench-clickhouse", "wrathbench-collector"];

describe.skipIf(helm === null)("the chart's groups", () => {
  test("every group on: every workload, and no pod told about groups or admin", () => {
    const docs = render();
    for (const n of [...RUNNER_WORKLOADS, ...VIEWER_WORKLOADS]) expect(names(docs)).toContain(n);
    for (const [name, v] of Object.entries(envOf(docs, "WRATHBENCH_GROUPS"))) expect(v, name).toBeUndefined();
    for (const [name, v] of Object.entries(envOf(docs, "WRATHBENCH_ADMIN"))) expect(v, name).toBeUndefined();
  }, HELM_TEST_MS);

  test("runner off: no supervisor, runner pod, run pods or codex home; the viewer and publisher are told", () => {
    const docs = render("--set", "groups.runner.enabled=false");
    for (const n of RUNNER_WORKLOADS) expect(names(docs)).not.toContain(n);
    for (const n of VIEWER_WORKLOADS) expect(names(docs)).toContain(n);
    const env = envOf(docs, "WRATHBENCH_GROUPS");
    expect(env["wrathbench-viewer"]).toBe("evals,viewer");
    expect(env["wrathbench-publisher"]).toBe("evals,viewer");
  }, HELM_TEST_MS);

  test("viewer off: no viewer, publisher, ClickHouse or collector, and no pod carries the store's coordinates", () => {
    const docs = render("--set", "groups.viewer.enabled=false");
    for (const n of VIEWER_WORKLOADS) expect(names(docs)).not.toContain(n);
    for (const n of RUNNER_WORKLOADS) expect(names(docs)).toContain(n);
    expect(envOf(docs, "WRATHBENCH_GROUPS")["wrathbench-fleet"]).toBe("runner,evals");
    for (const [name, v] of Object.entries(envOf(docs, "CLICKHOUSE_URL"))) expect(v, name).toBeUndefined();
  }, HELM_TEST_MS);

  test("evals off: every workload stays, and the four pods that read the config are told", () => {
    const docs = render("--set", "groups.evals.enabled=false");
    for (const n of [...RUNNER_WORKLOADS, ...VIEWER_WORKLOADS]) expect(names(docs)).toContain(n);
    const env = envOf(docs, "WRATHBENCH_GROUPS");
    for (const n of ["wrathbench-fleet", "wrathbench-runner", "wrathbench-viewer", "wrathbench-publisher"]) expect(env[n], n).toBe("runner,viewer");
  }, HELM_TEST_MS);
});

describe.skipIf(helm === null)("the chart's admin switch", () => {
  test("on: WRATHBENCH_ADMIN on the viewer and nowhere else", () => {
    const env = envOf(render("--set", "admin.enabled=true"), "WRATHBENCH_ADMIN");
    expect(env["wrathbench-viewer"]).toBe("1");
    for (const [name, v] of Object.entries(env)) if (name !== "wrathbench-viewer") expect(v, name).toBeUndefined();
  }, HELM_TEST_MS);

  test("on: the viewer is told the model keys' names and how publishing is set, and is handed no S3 secret", () => {
    const docs = render("--set", "admin.enabled=true", "--set", "publisher.delayMs=60000", "--set", "publisher.target.endpoint=https://s3.example", "--set", "publisher.target.bucket=pub");
    const viewer = docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-viewer")!;
    const env = viewer.spec!.template!.spec!.containers![0]!.env as { name: string; value?: string; valueFrom?: unknown }[];
    const by = new Map(env.map((e) => [e.name, e]));
    expect(by.get("WRATHBENCH_MODEL_KEYS")?.value).toContain("OPENROUTER_KEY");
    expect(by.get("WRATHBENCH_PUBLISHER")?.value).toBe("1");
    expect(by.get("WRATHBENCH_PUBLISH_DELAY_MS")?.value).toBe("60000");
    expect(by.get("WRATHBENCH_PUBLISH_TARGET")?.value).toBe("https://s3.example/pub");
    for (const e of env) if (e.name.startsWith("S3_") && e.name !== "S3_REGION") throw new Error(`the viewer carries ${e.name}`);
    expect(env.filter((e) => e.valueFrom !== undefined && JSON.stringify(e.valueFrom).includes("S3_"))).toEqual([]);
    // Without admin, none of it.
    const plain = render().find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-viewer")!;
    const names = (plain.spec!.template!.spec!.containers![0]!.env ?? []).map((e) => e.name);
    for (const n of ["WRATHBENCH_MODEL_KEYS", "WRATHBENCH_PUBLISHER", "WRATHBENCH_PUBLISH_STATE"]) expect(names).not.toContain(n);
  }, HELM_TEST_MS);

  test("on with the viewer off is refused", () => {
    for (const off of ["groups.viewer.enabled=false", "viewer.enabled=false"]) {
      const r = run("--set", "admin.enabled=true", "--set", off);
      expect(r.code, off).not.toBe(0);
      expect(r.err).toContain("admin.enabled");
    }
  }, HELM_TEST_MS);
});
