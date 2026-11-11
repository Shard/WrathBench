/**
 * The generated account pool in the chart (`worldserver.pool.size`), rendered
 * with helm when it is on PATH: one value puts POOL01 … POOLnn on the module's
 * allowlist after the named accounts, tells the bootstrap Job to create them,
 * and gives every pod that parses the fleet config the same size — never a run
 * pod, which reads no config. The names are runner/src/account-pool.ts's.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPoolAccountName, poolAccountNames } from "../runner/src/account-pool";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];

type Env = { name: string; value?: string };
type Container = { name: string; env?: Env[] };
type Doc = { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: { containers?: Container[] } } } } | null;

function render(extra: string[]): { code: number; stderr: string; docs: Doc[] } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  const docs = r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc) : [];
  return { code: r.exitCode ?? -1, stderr: r.stderr.toString(), docs };
}

const containerOf = (docs: Doc[], kind: string, name: string, container: string): Container => {
  const d = docs.find((x) => x?.kind === kind && x.metadata?.name === name);
  expect(d, `${kind}/${name} renders`).toBeDefined();
  const c = d!.spec!.template!.spec!.containers!.find((x) => x.name === container);
  expect(c, `${kind}/${name} has ${container}`).toBeDefined();
  return c!;
};
const envValue = (c: Container, name: string): string | undefined => c.env?.find((e) => e.name === name)?.value;

describe.skipIf(helm === null)("the chart's generated account pool", () => {
  test(
    "one size puts POOL01 … on the allowlist after the named accounts, in the bootstrap Job and in every config-reading pod",
    () => {
      const { code, docs } = render(["--set", "worldserver.pool.size=3", "--set", "worldserver.accounts={RUNNER,SMOKE}"]);
      expect(code).toBe(0);
      expect(envValue(containerOf(docs, "Deployment", "wrathbench-worldserver", "worldserver"), "AC_WRATH_BENCH_ACCOUNTS")).toBe(
        ["RUNNER", "SMOKE", ...poolAccountNames(3)].join(","),
      );
      expect(envValue(containerOf(docs, "Job", "wrathbench-bootstrap", "bootstrap"), "WRATHBENCH_POOL_SIZE")).toBe("3");
      for (const [name, container] of [
        ["wrathbench-fleet", "fleet"],
        ["wrathbench-viewer", "viewer"],
        ["wrathbench-runner", "runner"],
      ] as const) {
        expect(envValue(containerOf(docs, "Deployment", name, container), "WRATHBENCH_POOL_SIZE"), name).toBe("3");
      }
      // A run pod reads no config, so its template carries no pool.
      const template = docs.find((d) => d?.kind === "ConfigMap" && d.metadata?.name === "wrathbench-run-pod-template") as { data?: Record<string, string> } | undefined;
      expect(template?.data?.["pod.json"]).toContain("WRATHBENCH_RUNS_DIR");
      expect(template?.data?.["pod.json"]).not.toContain("WRATHBENCH_POOL_SIZE");
    },
    HELM_TEST_MS,
  );

  test(
    "size 0 adds nothing to the allowlist; a size past 99 does not render",
    () => {
      const none = render(["--set", "worldserver.pool.size=0", "--set", "worldserver.accounts={RUNNER}"]);
      expect(envValue(containerOf(none.docs, "Deployment", "wrathbench-worldserver", "worldserver"), "AC_WRATH_BENCH_ACCOUNTS")).toBe("RUNNER");
      const big = render(["--set", "worldserver.pool.size=100"]);
      expect(big.code).not.toBe(0);
      expect(big.stderr).toContain("worldserver.pool.size must be from 0 to 99");
    },
    HELM_TEST_MS,
  );
});

describe("the quickstart's generated account pool", () => {
  test("the allowlist lists exactly the pool x-pool-size makes, and bootstrap, runner, fleet and publisher read that size", () => {
    const compose = Bun.YAML.parse(readFileSync(join(import.meta.dir, "compose.yml"), "utf8")) as {
      "x-pool-size": string;
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const size = Number(compose["x-pool-size"]);
    expect(size).toBeGreaterThan(0);
    const allowlist = compose.services["worldserver"]!.environment!["AC_WRATH_BENCH_ACCOUNTS"]!.split(",");
    expect(allowlist.filter(isPoolAccountName)).toEqual(poolAccountNames(size));
    for (const svc of ["bootstrap", "runner", "fleet", "publisher"]) expect(compose.services[svc]!.environment!["WRATHBENCH_POOL_SIZE"], svc).toBe(String(size));
  });
});
