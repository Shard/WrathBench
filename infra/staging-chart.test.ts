/**
 * The chart's party-staging switch (`staging` in values.yaml), rendered with
 * helm when it is on PATH: off, it renders the objects the chart rendered
 * before the switch existed (SOAP off, no SOAP port, today's allowlist, no
 * STAGER anywhere); on, the worldserver serves SOAP on its pod address and
 * Service, the party's accounts join the allowlist, and STAGER never does.
 * The NetworkPolicy half is in networkpolicy.test.ts, the run-pod half in
 * run-pod.test.ts. The compose quickstart keeps SOAP off whatever the chart does.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];

type Env = { name: string; value?: string; valueFrom?: { fieldRef?: { fieldPath: string }; secretKeyRef?: { name: string; key: string; optional?: boolean } } };
type Doc = {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    ports?: { name: string; port: number; targetPort: number }[];
    template?: {
      spec?: {
        containers?: { name: string; env?: Env[]; ports?: { name: string; containerPort: number }[]; volumeMounts?: { name: string; mountPath: string; subPath?: string }[] }[];
      };
    };
  };
} | null;

function render(extra: string[]): { code: number; stderr: string; docs: Doc[] } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  const docs = r.exitCode === 0 ? r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc) : [];
  return { code: r.exitCode ?? -1, stderr: r.stderr.toString(), docs };
}

const find = (docs: Doc[], kind: string, name: string) => {
  const d = docs.find((x) => x?.kind === kind && x.metadata?.name === name);
  expect(d, `${kind}/${name} renders`).toBeDefined();
  return d!;
};
const worldserver = (docs: Doc[]) => find(docs, "Deployment", "wrathbench-worldserver").spec!.template!.spec!.containers!.find((c) => c.name === "worldserver")!;
const envOf = (c: { env?: Env[] }) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));

/** The default allowlist, as values.yaml lists it. */
const DEFAULT_ACCOUNTS = "RUNNER,RUNNER2,RUNNER3,RUNNER4,RUNNER5,RUNNER6,RUNNER7,SHAKEOUT,SHAKEOUT2,PROBE,SMOKE,SMOKE2,SMOKE3,SMOKE4";

describe.skipIf(helm === null)("the chart's party-staging switch", () => {
  test("off by default: SOAP off, no SOAP port or address, today's allowlist, and no SOAP or STAGER in any rendered object", () => {
    const { code, docs } = render([]);
    expect(code).toBe(0);
    const env = envOf(worldserver(docs));
    expect(env["AC_SOAP_ENABLED"]?.value).toBe("0");
    expect(env["AC_SOAP_IP"]).toBeUndefined();
    expect(env["AC_SOAP_PORT"]).toBeUndefined();
    expect(env["AC_WRATH_BENCH_ACCOUNTS"]?.value).toBe(DEFAULT_ACCOUNTS);
    expect(find(docs, "Service", "worldserver").spec!.ports!.map((p) => p.port)).toEqual([8085, 8086]);
    expect(worldserver(docs).ports!.map((p) => p.containerPort)).toEqual([8085, 8086]);
    // Parsed objects, so the YAML comments that explain the switch do not count.
    const all = JSON.stringify(docs);
    expect(all).not.toContain("7878");
    expect(all).not.toContain("STAGER");
    expect(all).not.toContain("WRATHBENCH_SOAP_URL");
    expect(all).not.toContain("PARTY1");
  }, HELM_TEST_MS);

  test("on: SOAP on the pod's own address and the Service, the party's accounts on the allowlist, STAGER not", () => {
    const { code, docs } = render(["--set", "staging.enabled=true"]);
    expect(code).toBe(0);
    const env = envOf(worldserver(docs));
    expect(env["AC_SOAP_ENABLED"]?.value).toBe("1");
    expect(env["AC_SOAP_IP"]?.valueFrom?.fieldRef?.fieldPath).toBe("status.podIP");
    expect(env["AC_SOAP_PORT"]?.value).toBe("7878");
    const accounts = env["AC_WRATH_BENCH_ACCOUNTS"]!.value!.split(",");
    expect(accounts).toEqual([...DEFAULT_ACCOUNTS.split(","), "PARTY1", "PARTY2", "PARTY3", "PARTY4", "PARTY5"]);
    expect(accounts).not.toContain("STAGER");
    const svc = find(docs, "Service", "worldserver").spec!.ports!;
    expect(svc.find((p) => p.name === "soap")).toEqual({ name: "soap", port: 7878, targetPort: 7878 });
    expect(svc.map((p) => p.port)).toEqual([8085, 8086, 7878]);
    expect(worldserver(docs).ports!.find((p) => p.name === "soap")?.containerPort).toBe(7878);
    // The worldserver itself is never handed STAGER's password: SOAP checks it against the auth DB.
    expect(Object.keys(env).some((n) => n.includes("STAGER"))).toBe(false);
  }, HELM_TEST_MS);

  test("the port is one value: a moved soapPort moves the env, the Service, the container port and the stager's URL together", () => {
    const { code, docs } = render(["--set", "staging.enabled=true", "--set", "staging.soapPort=7979"]);
    expect(code).toBe(0);
    expect(envOf(worldserver(docs))["AC_SOAP_PORT"]?.value).toBe("7979");
    expect(find(docs, "Service", "worldserver").spec!.ports!.find((p) => p.name === "soap")?.port).toBe(7979);
    const fleet = find(docs, "Deployment", "wrathbench-fleet").spec!.template!.spec!.containers![0]!;
    expect(envOf(fleet)["WRATHBENCH_SOAP_URL"]?.value).toBe("http://worldserver:7979/");
  }, HELM_TEST_MS);

  test("refuses to render STAGER onto the module's allowlist, from either list", () => {
    for (const extra of [
      ["--set", "staging.enabled=true", "--set", "staging.accounts={PARTY1,STAGER}"],
      ["--set", "worldserver.accounts={RUNNER,stager}"],
    ]) {
      const r = render(extra);
      expect([extra.join(" "), r.code === 0]).toEqual([extra.join(" "), false]);
      expect(r.stderr).toContain("STAGER may never be on the module's account allowlist");
    }
  }, HELM_TEST_MS);

  test("the character archive's pdump exchange: the worldserver mounts the runner's `characters` subPath and takes paths only with staging on", () => {
    const characters = (c: { volumeMounts?: { mountPath: string; subPath?: string }[] }) => c.volumeMounts?.find((m) => m.subPath === "characters");
    const runner = (docs: Doc[]) => find(docs, "Deployment", "wrathbench-runner").spec!.template!.spec!.containers!.find((c) => c.name === "runner")!;
    const off = render([]);
    expect(off.code).toBe(0);
    expect(characters(worldserver(off.docs))).toBeUndefined();
    expect(envOf(worldserver(off.docs))["AC_PLAYER_DUMP_DISALLOW_PATHS"]).toBeUndefined();
    // The archives themselves live there whatever the switch says.
    expect(characters(runner(off.docs))?.mountPath).toBe("/wrathbench/data/characters");
    const on = render(["--set", "staging.enabled=true"]);
    expect(on.code).toBe(0);
    expect(characters(worldserver(on.docs))?.mountPath).toBe("/azerothcore/env/dist/characters");
    expect(envOf(worldserver(on.docs))["AC_PLAYER_DUMP_DISALLOW_PATHS"]?.value).toBe("0");
    expect(characters(runner(on.docs))?.mountPath).toBe("/wrathbench/data/characters");
  }, HELM_TEST_MS);

  test("a party account already on worldserver.accounts is listed once", () => {
    const { docs } = render(["--set", "staging.enabled=true", "--set", "worldserver.accounts={RUNNER,PARTY1}"]);
    expect(envOf(worldserver(docs))["AC_WRATH_BENCH_ACCOUNTS"]?.value).toBe("RUNNER,PARTY1,PARTY2,PARTY3,PARTY4,PARTY5");
  }, HELM_TEST_MS);
});

test("the compose quickstart keeps SOAP off: it has no policy to contain it with", () => {
  const compose = readFileSync(join(import.meta.dir, "compose.yml"), "utf8");
  expect(compose).toMatch(/AC_SOAP_ENABLED:\s*"0"/);
  expect(compose).not.toMatch(/AC_SOAP_ENABLED:\s*"1"/);
  expect(compose).not.toContain("7878");
});
