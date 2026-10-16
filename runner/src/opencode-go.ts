/**
 * OpenCode Go's allowance, as a subscription lane (operator, 2026-10-16;
 * `subscription-usage.ts` has the gate).
 *
 * Go sells a metered allowance behind the same `openai` driver every
 * OpenAI-compatible endpoint uses. Its chat responses carry no usage or
 * rate-limit headers; what does is an account-wide usage endpoint,
 * `GET <origin>/inference/go/v1/usage` with the entry's own key as a bearer
 * token, which answers the allowance's `rolling`, `weekly` and `monthly`
 * windows, each with a `status`, an integer `percent` and a `resetsAt`. It is
 * undocumented, so it is read tolerantly: a shape this does not know is no
 * observation, said once, and the launch is allowed. Nothing here throws into
 * a caller, and nothing here ever logs or records the key.
 *
 * One lane per key (`opencode-go:<KEY ENV>`), for the entries that draw the
 * allowance down — a Go base and paid billing (`goKeyEnvOf`, models.ts). A
 * `$0` Go model does not, keeps working past the limit, and is never gated.
 *
 * Two readers share `GoUsagePoller`, which calls the endpoint at most once a
 * minute and keeps the newest answer: the fleet supervisor, before it decides
 * a launch or a resume (`FleetGoUsage`, infra/run-fleet-gate.ts), and a live
 * Go run, whose fixed loop pokes it at each turn boundary without waiting on
 * it (`GoUsageGauge`) — for the freeplay gate, and for a spent allowance's
 * reset when the adapter pauses `quota-exhausted` on Go's `GoUsageLimitError`.
 */
import { SubscriptionUsageTracker, type SubscriptionUsage, type UsageHold, type UsageWindow } from "./subscription-usage";

/** The usage endpoint's path on the Go base's origin. */
export const GO_USAGE_PATH = "/inference/go/v1/usage";
/** At most one call per lane in this long (the endpoint is undocumented: be a light client). */
export const GO_USAGE_MIN_INTERVAL_MS = 60_000;
/** A read that takes longer than this is no reading. */
export const GO_USAGE_TIMEOUT_MS = 10_000;

/** The usage endpoint for a Go base: the same origin, Go's own path. Undefined for a base that does not parse. */
export function goUsageUrl(apiBase: string | null | undefined): string | undefined {
  if (apiBase === null || apiBase === undefined) return undefined;
  try {
    return new URL(GO_USAGE_PATH, new URL(apiBase).origin).toString();
  } catch {
    return undefined;
  }
}

/**
 * Go's windows by name, and their lengths where the name says one. A rolling
 * and a monthly window carry their own `resetsAt`, which is what the gate
 * reads; their length is not stated, so it is not invented.
 */
const GO_WINDOWS: Readonly<Record<string, number | null>> = { rolling: null, weekly: 10_080, monthly: null };
/** A window status that says the allowance is spent, whatever its percent rounds to. */
const SPENT_STATUS = /exceed|exhaust|reached|block|reject|deplet/i;

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A reset as epoch ms: epoch seconds or milliseconds, or an ISO date. */
function resetMsOf(v: unknown): number | null {
  const n = finite(v);
  if (n !== undefined) return n < 1e11 ? n * 1000 : n;
  if (typeof v === "string" && v.length > 0) {
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) return parsed;
    const asNumber = Number(v);
    if (Number.isFinite(asNumber)) return asNumber < 1e11 ? asNumber * 1000 : asNumber;
  }
  return null;
}

/**
 * The usage windows off the endpoint's body — per window the used percent,
 * its length when known and its reset; nothing else — or undefined when the
 * body is not a shape this knows. Tolerant of the windows sitting at the top
 * level or under `usage` or `data`.
 */
export function goUsageWindows(body: unknown): UsageWindow[] | undefined {
  const top = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  for (const c of [top, top?.["usage"], top?.["data"]]) {
    if (c === null || typeof c !== "object") continue;
    const windows: UsageWindow[] = [];
    for (const [name, minutes] of Object.entries(GO_WINDOWS)) {
      const w = (c as Record<string, unknown>)[name];
      if (w === null || typeof w !== "object") continue;
      const o = w as Record<string, unknown>;
      const pct = finite(o["percent"]) ?? finite(o["usedPercent"]) ?? finite(o["used_percent"]);
      if (pct === undefined) continue;
      const spent = typeof o["status"] === "string" && SPENT_STATUS.test(o["status"]);
      windows.push({ usedPercent: spent ? Math.max(pct, 100) : pct, windowMinutes: minutes, resetsAt: resetMsOf(o["resetsAt"] ?? o["resets_at"]) });
    }
    if (windows.length > 0) return windows;
  }
  return undefined;
}

/** The slice of `fetch` the reader uses; a test passes its own. */
export type GoFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One read of the endpoint: the windows, or why there are none. Never throws, never names the key. */
export async function readGoUsage(
  url: string,
  key: string,
  fetchImpl: GoFetch = fetch as unknown as GoFetch,
  timeoutMs = GO_USAGE_TIMEOUT_MS,
): Promise<{ windows: UsageWindow[] } | { why: string }> {
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { why: `HTTP ${res.status}` };
    const windows = goUsageWindows(await res.json());
    return windows === undefined ? { why: "a response shape this reader does not know" } : { windows };
  } catch (e) {
    // The error's NAME only: a message can quote the request.
    return { why: e instanceof Error ? e.name : "fetch failed" };
  }
}

export interface GoUsagePollerOptions {
  fetch?: GoFetch;
  now?: () => number;
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Said once per poller (per boot): the first read that came back with nothing. */
  onNote?: (text: string) => void;
  /** Every successful reading. */
  onReading?: (windows: UsageWindow[], at: number) => void;
}

/** One lane's endpoint, read at most once per interval, the newest answer kept. */
export class GoUsagePoller {
  private lastAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private latest: SubscriptionUsage | undefined;
  private noted = false;

  constructor(
    readonly lane: string,
    private readonly url: string,
    private readonly key: string,
    private readonly o: GoUsagePollerOptions = {},
  ) {}

  /** The newest reading, or undefined before the first good one. */
  get current(): SubscriptionUsage | undefined {
    return this.latest;
  }

  /** Read again when the last read is older than the interval; resolves once done, or at once when not due. Never rejects. */
  refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const now = (this.o.now ?? Date.now)();
    if (now - this.lastAt < (this.o.minIntervalMs ?? GO_USAGE_MIN_INTERVAL_MS)) return Promise.resolve();
    this.lastAt = now;
    this.inFlight = readGoUsage(this.url, this.key, this.o.fetch, this.o.timeoutMs)
      .then((r) => {
        if ("windows" in r) {
          this.latest = { lane: this.lane, observedAt: now, windows: r.windows };
          this.o.onReading?.(r.windows, now);
        } else if (!this.noted) {
          this.noted = true;
          this.o.onNote?.(`OpenCode Go usage for ${this.lane} not read (${r.why}): no observation, so its launches are not held`);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

/**
 * A live Go run's view of its lane (`LoopOptions.usage`): poked at each turn
 * boundary and never waited on there, so a turn costs no call; readings are
 * recorded on change like the CLI drivers' (`SubscriptionUsageTracker`).
 */
export class GoUsageGauge {
  private readonly tracker: SubscriptionUsageTracker;
  private readonly poller: GoUsagePoller;

  constructor(lane: string, url: string, key: string, write: (u: SubscriptionUsage) => void, o: Omit<GoUsagePollerOptions, "onReading"> = {}) {
    this.tracker = new SubscriptionUsageTracker(lane, write);
    this.poller = new GoUsagePoller(lane, url, key, { ...o, onReading: (windows, at) => this.tracker.observe(windows, at) });
  }

  get current(): SubscriptionUsage | undefined {
    return this.tracker.current;
  }

  /** A background refresh when one is due. */
  poke(): void {
    void this.poller.refresh();
  }

  freeplayHold(threshold: number, now: number): UsageHold | null {
    return this.tracker.freeplayHold(threshold, now);
  }

  /** A spent allowance's reset (the pause's `notBefore`), off a reading at most a minute old. */
  async quotaReset(now: number): Promise<number | undefined> {
    await this.poller.refresh();
    return this.tracker.quotaReset(now);
  }
}
