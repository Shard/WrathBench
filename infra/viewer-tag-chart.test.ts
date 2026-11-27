/**
 * The viewer group's tag (values.yaml `image.viewerTag`, templates/_helpers.tpl
 * `wrathbench.viewerTag`): what a viewer release (infra/k8s-release-viewer.sh)
 * pins. Setting it alone must move the images of the viewer, the publisher and
 * the collector and nothing else: not the fleet, the runner pod, the run-pod
 * template, the worldserver, the camera or either hook Job, and not the harness
 * stamp any pod carries. Left empty, or set to `image.tag`, the chart renders
 * exactly what it rendered before the key existed.
 *
 * The comparison is the whole render, as text: the render with the viewer tag
 * at B, with B written back to A, must equal the render at A, and B may occur
 * only on the three viewer-group workloads' `image:` lines. So anything else
 * that started reading the key, a hook Job's image or an env var, fails here.
 * Rendered as an install and as an upgrade (`--is-upgrade`), since an upgrade
 * is what a pin is and the hook Jobs are what runs on one.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const A = "harness-0.9-10-gaaaaaaa";
const B = "harness-0.9-17-gbbbbbbb";
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", `image.tag=${A}`];
const VIEWER_GROUP = ["wrathbench-viewer", "wrathbench-publisher", "wrathbench-collector"];

type Env = { name: string; value?: string };
type Container = { name: string; image?: string; env?: Env[] };
type Doc = {
  kind?: string;
  metadata?: { name?: string };
  spec?: { template?: { spec?: { containers?: Container[]; initContainers?: Container[] } } };
  template?: { spec?: { containers?: Container[] } };
} | null;

function run(...extra: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function render(...extra: string[]): string {
  const r = run(...extra);
  expect(r.code, r.err).toBe(0);
  return r.out;
}

const docsOf = (out: string): { text: string; doc: Doc }[] =>
  out
    .split(/^---$/m)
    .map((text) => ({ text, doc: Bun.YAML.parse(text) as Doc }))
    .filter((d) => d.doc !== null);

/** Every container of a workload, a pod template (run pods) included. */
const containersOf = (d: Doc): Container[] => [
  ...(d?.spec?.template?.spec?.containers ?? []),
  ...(d?.spec?.template?.spec?.initContainers ?? []),
  ...(d?.template?.spec?.containers ?? []),
];

/** The variants a pin can be rendered as: the chart's defaults and the example's wider set of workloads, installed and upgraded. */
const VARIANTS: [string, string[]][] = [
  ["defaults", []],
  ["defaults, upgrade", ["--is-upgrade"]],
  ["example", ["-f", join(chart, "values.example.yaml")]],
  ["example, upgrade", ["-f", join(chart, "values.example.yaml"), "--is-upgrade"]],
];

describe.skipIf(helm === null)("the viewer group's tag", () => {
  test("empty, or equal to image.tag, renders byte for byte what the chart rendered without it", () => {
    for (const [what, extra] of VARIANTS) {
      expect(render(...extra, "--set", `image.viewerTag=${A}`), what).toBe(render(...extra));
    }
  }, HELM_TEST_MS);

  test("set alone, it moves the viewer, publisher and collector images and nothing else, the hook Jobs included", () => {
    for (const [what, extra] of VARIANTS) {
      const atA = render(...extra);
      const atB = render(...extra, "--set", `image.viewerTag=${B}`);
      // Everything but the tag is the same render.
      expect(atB.replaceAll(B, A), what).toBe(atA);
      // And the tag lands only on the viewer group's image lines.
      for (const { text, doc } of docsOf(atB)) {
        const name = doc?.metadata?.name ?? "";
        const lines = text.split("\n").filter((l) => l.includes(B));
        if (VIEWER_GROUP.includes(name) && doc?.kind === "Deployment") {
          expect(lines.length, `${what}: ${name}`).toBeGreaterThan(0);
          for (const l of lines) expect(l.trim(), `${what}: ${name}`).toMatch(new RegExp(`^image: harbor\\.example/wrathbench/wrathbench-runner:${B}$`));
        } else {
          expect(lines, `${what}: ${doc?.kind}/${name}`).toEqual([]);
        }
      }
      // Every viewer-group Deployment rendered and moved; the hook Jobs rendered and did not.
      const docs = docsOf(atB).map((d) => d.doc);
      for (const n of VIEWER_GROUP) {
        const d = docs.find((x) => x?.kind === "Deployment" && x.metadata?.name === n);
        expect(d, `${what}: ${n}`).toBeDefined();
        expect(containersOf(d!).map((c) => c.image)).toEqual([`harbor.example/wrathbench/wrathbench-runner:${B}`]);
      }
      for (const n of ["wrathbench-db-import", "wrathbench-bootstrap"]) {
        const job = docs.find((x) => x?.kind === "Job" && x.metadata?.name === n);
        expect(job, `${what}: ${n}`).toBeDefined();
        for (const c of containersOf(job!)) expect(c.image, `${what}: ${n}/${c.name}`).toEndWith(`:${A}`);
      }
    }
  }, HELM_TEST_MS);

  test("the harness stamp stays the fleet's on every pod, the viewer group's included", () => {
    const out = render("--set", `image.viewerTag=${B}`);
    const seen: string[] = [];
    for (const { doc: d } of docsOf(out)) {
      for (const c of containersOf(d)) {
        const v = c.env?.find((e) => e.name === "WRATHBENCH_HARNESS_VERSION")?.value;
        if (v === undefined) continue;
        seen.push(d?.metadata?.name ?? "");
        expect(v, `${d?.metadata?.name}/${c.name}`).toBe(A);
      }
    }
    expect(seen.sort()).toEqual(["wrathbench-fleet", "wrathbench-publisher", "wrathbench-runner", "wrathbench-viewer"]);
    // The run-pod template is JSON inside a ConfigMap: its stamp is the fleet's as well.
    expect(out).toMatch(new RegExp(`"name": "WRATHBENCH_HARNESS_VERSION",\\s*"value": "${A}"`));
  }, HELM_TEST_MS);

  test("the slim viewer image takes the viewer group's tag too", () => {
    const docs = docsOf(render("--set", "image.names.viewer=wrathbench-viewer", "--set", `image.viewerTag=${B}`)).map((d) => d.doc);
    const viewer = docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-viewer")!;
    expect(containersOf(viewer).map((c) => c.image)).toEqual([`harbor.example/wrathbench/wrathbench-viewer:${B}`]);
  }, HELM_TEST_MS);

  test("`latest` is refused, as it is for image.tag", () => {
    const r = run("--set", "image.viewerTag=latest");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("image.viewerTag must be an immutable tag");
  }, HELM_TEST_MS);
});
