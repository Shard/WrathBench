/**
 * The publisher's settings (infra/publish-settings.ts) and the chart that
 * renders them: every default is the publisher as it was, and every other
 * value reaches the pod as the one variable that says it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { describePublishSettings, MAX_DELAY_MS, publishSettingsFromEnv } from "./publish-settings";

const KEYS = { S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret", S3_BUCKET: "public" };

describe("publishSettingsFromEnv", () => {
  test("today's environment: an endpoint, no delay, the history", () => {
    expect(publishSettingsFromEnv({ ...KEYS, S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com" })).toEqual({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "public",
      region: null,
      virtualHostedStyle: false,
      delayMs: 0,
      history: true,
    });
  });

  test("any S3-compatible target: no endpoint is AWS's from the region, and AWS_* names are Bun's fallback", () => {
    const s = publishSettingsFromEnv({ AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "s", AWS_BUCKET: "b", S3_REGION: "eu-west-1", WRATHBENCH_PUBLISH_VIRTUAL_HOSTED: "1" });
    expect(s).toMatchObject({ endpoint: null, bucket: "b", region: "eu-west-1", virtualHostedStyle: true });
    expect(describePublishSettings(s as Exclude<typeof s, { error: string }>)).toBe("s3://b (region eu-west-1, virtual-hosted, no delay, with the history)");
  });

  test("a delay and the current view only", () => {
    const s = publishSettingsFromEnv({ ...KEYS, S3_ENDPOINT: "http://minio:9000", WRATHBENCH_PUBLISH_DELAY_MS: "900000", WRATHBENCH_PUBLISH_HISTORY: "0" });
    expect(s).toMatchObject({ delayMs: 900_000, history: false });
    expect(describePublishSettings(s as Exclude<typeof s, { error: string }>)).toBe("http://minio:9000/public (15 min behind, the current view only)");
  });

  test("what does not read is refused with the variable's name, never a value", () => {
    expect(publishSettingsFromEnv({ S3_ACCESS_KEY_ID: "id", S3_BUCKET: "b" })).toEqual({ error: expect.stringContaining("S3_SECRET_ACCESS_KEY is not set") });
    for (const [k, v] of [
      ["WRATHBENCH_PUBLISH_DELAY_MS", "-1"],
      ["WRATHBENCH_PUBLISH_DELAY_MS", "soon"],
      ["WRATHBENCH_PUBLISH_DELAY_MS", String(MAX_DELAY_MS + 1)],
      ["WRATHBENCH_PUBLISH_HISTORY", "no"],
      ["WRATHBENCH_PUBLISH_VIRTUAL_HOSTED", "yes"],
      ["S3_ENDPOINT", "minio:9000"],
    ] as const) {
      const r = publishSettingsFromEnv({ ...KEYS, [k]: v });
      expect("error" in r, `${k}=${v}`).toBe(true);
      expect((r as { error: string }).error).not.toContain("secret");
    }
  });
});

const helm = Bun.which("helm");
const chart = join(import.meta.dir, "chart", "wrathbench");
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0", "--show-only", "templates/publisher.yaml"];

type EnvVar = { name: string; value?: string; valueFrom?: { secretKeyRef?: { key: string } } };
function publisherEnv(...extra: string[]): Record<string, string> {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE, ...extra], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const doc = Bun.YAML.parse(r.stdout.toString()) as { spec: { template: { spec: { containers: { env: EnvVar[] }[] } } } };
  const out: Record<string, string> = {};
  for (const e of doc.spec.template.spec.containers[0]!.env) out[e.name] = e.value ?? `secret:${e.valueFrom?.secretKeyRef?.key ?? "?"}`;
  return out;
}

describe.skipIf(helm === null)("the chart's publisher block", () => {
  test("by default: the four S3 names from the Secret, and no other publishing variable", () => {
    const env = publisherEnv();
    for (const k of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET", "S3_ENDPOINT"]) expect(env[k]).toBe(`secret:${k}`);
    for (const k of ["S3_REGION", "WRATHBENCH_PUBLISH_DELAY_MS", "WRATHBENCH_PUBLISH_HISTORY", "WRATHBENCH_PUBLISH_VIRTUAL_HOSTED"]) expect(env[k]).toBeUndefined();
  }, 30_000);

  test("set: a plain endpoint and bucket, the region, the style, the delay and the current view", () => {
    const env = publisherEnv(
      "--set", "publisher.target.endpoint=http://minio.lan:9000",
      "--set", "publisher.target.bucket=pub",
      "--set", "publisher.target.region=auto",
      "--set", "publisher.target.virtualHostedStyle=true",
      "--set", "publisher.delayMs=900000",
      "--set", "publisher.history=false",
    );
    expect(env).toMatchObject({
      S3_ACCESS_KEY_ID: "secret:S3_ACCESS_KEY_ID",
      S3_SECRET_ACCESS_KEY: "secret:S3_SECRET_ACCESS_KEY",
      S3_ENDPOINT: "http://minio.lan:9000",
      S3_BUCKET: "pub",
      S3_REGION: "auto",
      WRATHBENCH_PUBLISH_VIRTUAL_HOSTED: "1",
      WRATHBENCH_PUBLISH_DELAY_MS: "900000",
      WRATHBENCH_PUBLISH_HISTORY: "0",
    });
    // What the chart renders is what the publisher reads.
    expect(publishSettingsFromEnv({ ...env, S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "s" })).toMatchObject({ delayMs: 900_000, history: false, virtualHostedStyle: true });
  }, 30_000);
});
