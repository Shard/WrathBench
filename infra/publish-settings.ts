/**
 * How a deployment publishes its public site, from the publisher's environment
 * (GitHub issue #427): where to, how far behind live play, and whether the
 * history goes too. Deployment config, like the groups: the chart's
 * `publisher` block renders it, and `publisher.enabled: false` (or the viewer
 * group off) is the deployment that publishes nothing, which has no publisher
 * at all. Every default is the publisher as it was before these existed.
 *
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY  the bucket's key pair (the Secret)
 *   S3_BUCKET                               the bucket
 *   S3_ENDPOINT                             any S3-compatible endpoint: R2, MinIO,
 *                                           Spaces, AWS; optional for AWS, where
 *                                           Bun derives it from the region
 *   S3_REGION                               Bun's own; its default is us-east-1,
 *                                           and R2 takes `auto`
 *   WRATHBENCH_PUBLISH_VIRTUAL_HOSTED=1     bucket-in-the-hostname endpoints
 *   WRATHBENCH_PUBLISH_DELAY_MS             how far the public view trails; 0
 *   WRATHBENCH_PUBLISH_HISTORY=0            only the current view
 *
 * Pure over the environment it is handed, so a test and the admin page read
 * the same verdict the publisher does.
 */

export interface PublishSettings {
  /** The bucket's endpoint, or null for one Bun derives (AWS, from the region). */
  endpoint: string | null;
  bucket: string;
  /** null is Bun's default. */
  region: string | null;
  virtualHostedStyle: boolean;
  /** How far the public view trails the render, ms; 0 shows each pass as rendered. */
  delayMs: number;
  /** false publishes only the runs that have not ended (`RendererOptions.history`). */
  history: boolean;
}

/** The longest a delay may be: a day of held passes is already a large state file. */
export const MAX_DELAY_MS = 24 * 60 * 60_000;

/** An `S3_*` variable, or its `AWS_*` fallback, as Bun's client reads them; empty is unset. */
function s3Var(env: Record<string, string | undefined>, name: string): string | null {
  const v = env[name] ?? env[name.replace(/^S3_/, "AWS_")];
  return v === undefined || v === "" ? null : v;
}

/**
 * The settings, or the sentence that says what is wrong with them. The key
 * pair is required and its values are never read here beyond being set.
 */
export function publishSettingsFromEnv(env: Record<string, string | undefined>): PublishSettings | { error: string } {
  for (const name of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"] as const) {
    if (s3Var(env, name) === null) return { error: `${name} is not set (docs/RUNBOOK.md, "Public dashboard": the bucket's key pair and name are in the Secret)` };
  }
  const delayRaw = env["WRATHBENCH_PUBLISH_DELAY_MS"];
  const delayMs = delayRaw === undefined || delayRaw === "" ? 0 : Number(delayRaw);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) {
    return { error: `WRATHBENCH_PUBLISH_DELAY_MS=${delayRaw} is not a delay in ms (0 to ${MAX_DELAY_MS})` };
  }
  const historyRaw = env["WRATHBENCH_PUBLISH_HISTORY"];
  if (historyRaw !== undefined && historyRaw !== "" && historyRaw !== "0" && historyRaw !== "1") {
    return { error: `WRATHBENCH_PUBLISH_HISTORY=${historyRaw} is 1 (the history, the default) or 0 (only the current view)` };
  }
  const hosted = env["WRATHBENCH_PUBLISH_VIRTUAL_HOSTED"];
  if (hosted !== undefined && hosted !== "" && hosted !== "0" && hosted !== "1") {
    return { error: `WRATHBENCH_PUBLISH_VIRTUAL_HOSTED=${hosted} is 1 or 0` };
  }
  const endpoint = s3Var(env, "S3_ENDPOINT");
  if (endpoint !== null && !/^https?:\/\/[^/]/.test(endpoint)) return { error: `S3_ENDPOINT is not an http(s) URL` };
  return {
    endpoint,
    bucket: s3Var(env, "S3_BUCKET")!,
    region: s3Var(env, "S3_REGION"),
    virtualHostedStyle: hosted === "1",
    delayMs,
    history: historyRaw !== "0",
  };
}

/**
 * Which kind of store an endpoint is, and nothing more of it: the endpoint is
 * read from the Secret, and R2's carries the account id in its hostname.
 * No endpoint is AWS's, which Bun derives from the region.
 */
export function storeKind(endpoint: string | null): "aws s3" | "r2" | "s3-compatible" {
  if (endpoint === null) return "aws s3";
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "s3-compatible";
  }
  if (host.endsWith(".r2.cloudflarestorage.com")) return "r2";
  if (host === "amazonaws.com" || host.endsWith(".amazonaws.com")) return "aws s3";
  return "s3-compatible";
}

/** One line for a log or a page: the bucket and the kind of store, and how. Never the endpoint, and no secret. */
export function describePublishSettings(s: PublishSettings): string {
  const where = `bucket ${s.bucket} on ${storeKind(s.endpoint)}`;
  const how = [
    ...(s.region !== null ? [`region ${s.region}`] : []),
    ...(s.virtualHostedStyle ? ["virtual-hosted"] : []),
    s.delayMs === 0 ? "no delay" : s.delayMs < 60_000 ? `${Math.round(s.delayMs / 1000)} s behind` : `${Math.round(s.delayMs / 60_000)} min behind`,
    s.history ? "with the history" : "the current view only",
  ];
  return `${where} (${how.join(", ")})`;
}

/**
 * What the admin page may say about publishing, from the viewer's environment
 * (the chart hands the viewer the same non-secret settings, and the target
 * only where it is a plain value): whether this deployment has a publisher,
 * and how it is set. Never the key pair, and never a value from the Secret.
 */
export interface PublishView {
  /** Whether the deployment renders a publisher at all (`WRATHBENCH_PUBLISHER`); null when the viewer was not told. */
  enabled: boolean | null;
  /** `<endpoint>/<bucket>` when the chart sets both as plain values; null when they are the Secret's. */
  target: string | null;
  region: string | null;
  virtualHostedStyle: boolean;
  delayMs: number;
  history: boolean;
}

export function publishViewFromEnv(env: Record<string, string | undefined>): PublishView {
  const flag = env["WRATHBENCH_PUBLISHER"];
  const delay = Number(env["WRATHBENCH_PUBLISH_DELAY_MS"] ?? "0");
  const target = env["WRATHBENCH_PUBLISH_TARGET"];
  return {
    enabled: flag === "1" ? true : flag === "0" ? false : null,
    target: target === undefined || target === "" ? null : target,
    region: env["S3_REGION"] === undefined || env["S3_REGION"] === "" ? null : env["S3_REGION"],
    virtualHostedStyle: env["WRATHBENCH_PUBLISH_VIRTUAL_HOSTED"] === "1",
    delayMs: Number.isInteger(delay) && delay > 0 ? delay : 0,
    history: env["WRATHBENCH_PUBLISH_HISTORY"] !== "0",
  };
}
