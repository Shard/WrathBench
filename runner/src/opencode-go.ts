/**
 * OpenCode Go's allowance, as a credential's usage windows (operator,
 * 2026-10-16; `subscription-usage.ts` has the budget).
 *
 * Go sells a metered allowance behind the same `openai` driver every
 * OpenAI-compatible endpoint uses. Its chat responses carry no rate-limit
 * headers; what does say how full the allowance is is an account-wide usage
 * endpoint, `GET <origin>/inference/go/v1/usage` with the entry's own key as
 * a bearer token — the endpoint OpenCode's own client reads with a key —
 * which answers the allowance's `rolling` (five hours), `weekly` and
 * `monthly` windows, each with a `status` (`ok`, or `rate-limited` when it is
 * spent), an integer `percent` and a `resetsAt`. It is not on a public docs
 * page, so it is read tolerantly. Nothing here throws into a caller, and
 * nothing here ever logs or records the key.
 *
 * Every read is classified (`CredentialRead`), and a failed read is not
 * "nothing to hold" (an expired key read as an open gate for days once):
 *
 * - 401 is `auth-failed`: the key itself is refused, so every launch on it
 *   would fail too. The fleet holds every Go credential naming that key.
 * - 403 is `no-access`: the key may not read usage, or the workspace has no
 *   Go plan. The fleet holds that credential.
 * - Anything else that is not an answer — a timeout, a 5xx, a shape this does
 *   not know — is `unread`: no observation, nothing held, but visible with
 *   when it began.
 * - A window Go says is spent is `spent`, and reads 100% whatever its percent
 *   rounds to, so the quota-reset rule holds it.
 *
 * Each response also carries `usage.opencode.billing_source`: `balance` means
 * the call was billed to the account's balance past the allowance (Go's Extra
 * Usage), which is money, not allowance. The run that sees it records it
 * (`goOverageOf`, `Trajectory.recordCredentialOverage`) and marks its
 * allowance spent; the supervisor reads it off the run and classifies the
 * credential `overage`, held until a later usage read shows room again.
 *
 * One reading per paid `opencode-go` credential, whatever its budget's kind
 * (`readsGoUsage`, infra/run-fleet-credentials.ts): the credential the
 * allowance-drawing entries take. A `usage` budget holds it at its thresholds;
 * any other budget still holds it on a refused key, a key with no access or a
 * spent window. A `$0` Go model does not draw the allowance down, keeps
 * working past the limit, and runs on a free credential, which is not read,
 * so no reading holds it — only a refused key, which is the same key.
 *
 * Two readers share `GoUsagePoller`, which calls the endpoint at most once a
 * minute and keeps the newest answer: the fleet supervisor, before it decides
 * a launch or a resume (`FleetGoUsage`, infra/run-fleet-credentials.ts), and a live
 * Go run, whose fixed loop pokes it at each turn boundary without waiting on
 * it (`GoUsageGauge`) — for the freeplay gate, and for a spent allowance's
 * reset when the adapter pauses `quota-exhausted` on Go's `GoUsageLimitError`.
 */
import type { CredentialRead } from "./credential-health";
import { EXHAUSTED_PCT, SUBSCRIPTION_RESET_CEILING_MS, SubscriptionUsageTracker, spentWindowOf, type SubscriptionUsage, type UsageHold, type UsageWindow } from "./subscription-usage";

/** The usage endpoint's path on the Go base's origin. */
export const GO_USAGE_PATH = "/inference/go/v1/usage";
/** At most one call per credential in this long (the endpoint is undocumented: be a light client). */
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
 * Go's windows by name, and their lengths: five hours, a week, a month. The
 * month's is nominal (a plan's month runs from its own subscription day); a
 * reading carries each window's own `resetsAt`, which is what the gate reads,
 * and the length only names the window and stands in when a reset is missing.
 */
const GO_WINDOWS: Readonly<Record<string, number>> = { rolling: 300, weekly: 10_080, monthly: 43_200 };
/** The one status Go sends for a window with room. Any other (`rate-limited`) is a spent window. */
const OPEN_STATUS = /^ok$/i;

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
      const spent = typeof o["status"] === "string" && !OPEN_STATUS.test(o["status"]);
      windows.push({ usedPercent: spent ? Math.max(pct, EXHAUSTED_PCT) : pct, windowMinutes: minutes, resetsAt: resetMsOf(o["resetsAt"] ?? o["resets_at"]) });
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

/** One read of the endpoint: the windows, or how it failed. */
export type GoUsageResult =
  | { ok: true; windows: UsageWindow[] }
  | { ok: false; classification: "auth-failed" | "no-access" | "unread"; http: number | null; code?: string };

/** A code a body or an error may name, kept only when it is one short token: never a message, which can quote anything. */
function codeToken(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : undefined;
}

/** The error code off a refusal's body (`{ error: { code | type } }` or `{ type }`), or undefined. */
function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const e = b["error"] !== null && typeof b["error"] === "object" ? (b["error"] as Record<string, unknown>) : undefined;
  return codeToken(e?.["code"]) ?? codeToken(e?.["type"]) ?? codeToken(b["code"]) ?? codeToken(b["type"]) ?? codeToken(b["error"]);
}

/** One read of the endpoint, classified. Never throws, never names the key. */
export async function readGoUsage(
  url: string,
  key: string,
  fetchImpl: GoFetch = fetch as unknown as GoFetch,
  timeoutMs = GO_USAGE_TIMEOUT_MS,
): Promise<GoUsageResult> {
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const code = errorCodeOf(await res.json().catch(() => undefined));
      const classification = res.status === 401 ? "auth-failed" : res.status === 403 ? "no-access" : "unread";
      return { ok: false, classification, http: res.status, ...(code !== undefined ? { code } : {}) };
    }
    const windows = goUsageWindows(await res.json());
    return windows === undefined ? { ok: false, classification: "unread", http: res.status, code: "unknown-shape" } : { ok: true, windows };
  } catch (e) {
    // The error's NAME only: a message can quote the request.
    return { ok: false, classification: "unread", http: null, code: e instanceof Error ? e.name : "fetch-failed" };
  }
}

/** "HTTP 401 api_key_expired", "TimeoutError": a read's failure in a few words, never a secret. */
export function describeRead(r: Pick<CredentialRead, "http" | "code">): string {
  return [r.http !== null ? `HTTP ${r.http}` : null, r.code ?? null].filter((x) => x !== null).join(" ") || "no answer";
}

/**
 * Whether a Go response was billed to the account's balance rather than the
 * allowance: its `usage.opencode.billing_source` is `balance` (Go's Extra
 * Usage, past a spent window). Read off the response body as the adapter kept
 * it (`AssistantTurn.raw`); false for anything else, any other provider included.
 */
export function goOverageOf(raw: unknown): boolean {
  const usage = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["usage"] : undefined;
  const oc = usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>)["opencode"] : undefined;
  return oc !== null && typeof oc === "object" && (oc as Record<string, unknown>)["billing_source"] === "balance";
}

export interface GoUsagePollerOptions {
  fetch?: GoFetch;
  now?: () => number;
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Said when the read's classification changes (never the key). */
  onNote?: (text: string) => void;
  /** Every successful reading. */
  onReading?: (windows: UsageWindow[], at: number) => void;
}

/** One credential's endpoint, read at most once per interval, the newest answer kept. */
export class GoUsagePoller {
  private lastAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private latest: SubscriptionUsage | undefined;
  /** The newest balance charge a run on this credential recorded, until a read shows room after it. */
  private overageAt: number | undefined;
  /** The newest read that showed every window with room. */
  private roomAt: number | undefined;
  /** The last read, classified (`CredentialRead`); undefined before the first. The status's health input (`FleetGoUsage.lastReads`). */
  lastRead: CredentialRead | undefined;

  constructor(
    readonly credential: string,
    private readonly url: string,
    private readonly key: string,
    private readonly o: GoUsagePollerOptions = {},
  ) {}

  /** The newest reading, or undefined before the first good one. */
  get current(): SubscriptionUsage | undefined {
    return this.latest;
  }

  /**
   * A run on this credential was billed to the balance at `at`. It stands —
   * the read classified `overage` — until a read made at least an interval
   * later shows every window with room; one already made is honoured. One
   * older than the seven-day ceiling every reading keeps is no longer news.
   */
  noteOverage(at: number): void {
    if (!Number.isFinite(at) || at <= (this.o.now ?? Date.now)() - SUBSCRIPTION_RESET_CEILING_MS) return;
    if (this.roomAt !== undefined && this.roomAt >= at + this.interval()) return;
    if (this.overageAt !== undefined && this.overageAt >= at) return;
    this.overageAt = at;
    const prev = this.lastRead;
    if (prev?.classification === "auth-failed" || prev?.classification === "no-access") return;
    this.classify(prev?.at ?? at, prev?.http ?? null, "balance", "overage", at);
  }

  /** Read again when the last read is older than the interval; resolves once done, or at once when not due. Never rejects. */
  refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const now = (this.o.now ?? Date.now)();
    if (now - this.lastAt < this.interval()) return Promise.resolve();
    this.lastAt = now;
    this.inFlight = readGoUsage(this.url, this.key, this.o.fetch, this.o.timeoutMs)
      .then((r) => {
        if (r.ok) {
          this.latest = { credential: this.credential, observedAt: now, windows: r.windows };
          this.o.onReading?.(r.windows, now);
          const spent = r.windows.some((w) => w.usedPercent >= EXHAUSTED_PCT);
          if (!spent) {
            this.roomAt = now;
            if (this.overageAt !== undefined && now >= this.overageAt + this.interval()) this.overageAt = undefined;
          }
          if (this.overageAt !== undefined) this.classify(now, 200, "balance", "overage");
          else this.classify(now, 200, spent ? "rate-limited" : undefined, spent ? "spent" : "ok");
        } else if (this.overageAt !== undefined && r.classification === "unread") {
          this.classify(now, r.http, "balance", "overage");
        } else {
          this.classify(now, r.http, r.code, r.classification);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private interval(): number {
    return this.o.minIntervalMs ?? GO_USAGE_MIN_INTERVAL_MS;
  }

  /** Keep the read, carrying `since` while the classification stands (else `began`), and say a change. */
  private classify(at: number, http: number | null, code: string | undefined, classification: CredentialRead["classification"], began = at): void {
    const prev = this.lastRead;
    const since = prev !== undefined && prev.classification === classification ? (prev.since ?? prev.at) : began;
    this.lastRead = { at, http, ...(code !== undefined ? { code } : {}), classification, since };
    if (prev?.classification === classification || (prev === undefined && (classification === "ok" || classification === "spent"))) return;
    const said = describeRead(this.lastRead);
    const text =
      classification === "auth-failed"
        ? `its key was refused reading OpenCode Go usage (${said}): its launches are held until a read succeeds`
        : classification === "no-access"
          ? `its key may not read OpenCode Go usage (${said}): its launches are held until a read succeeds`
          : classification === "overage"
            ? "a run on it was billed to the balance past the OpenCode Go allowance: its launches are held until its usage shows room"
            : classification === "unread"
              ? `OpenCode Go usage not read (${said}): no observation, so its launches are not held`
              : `OpenCode Go usage read again (${classification})`;
    this.o.onNote?.(`OpenCode Go usage for ${this.credential}: ${text}`);
  }
}

/**
 * A live Go run's view of its credential (`LoopOptions.usage`): poked at each turn
 * boundary and never waited on there, so a turn costs no call; readings are
 * recorded on change like the CLI drivers' (`SubscriptionUsageTracker`).
 */
export class GoUsageGauge {
  private readonly tracker: SubscriptionUsageTracker;
  private readonly poller: GoUsagePoller;

  constructor(credential: string, url: string, key: string, write: (u: SubscriptionUsage) => void, o: Omit<GoUsagePollerOptions, "onReading"> = {}) {
    this.tracker = new SubscriptionUsageTracker(credential, write);
    this.poller = new GoUsagePoller(credential, url, key, { ...o, onReading: (windows, at) => this.tracker.observe(windows, at) });
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

  /**
   * A response billed to the balance (`goOverageOf`): the allowance is spent,
   * whatever the last reading said. The most-used window in force is recorded
   * at 100% — or, with no reading, a five-hour window — so the freeplay gate
   * stops this run at its turn boundary and the fleet's budget holds the
   * credential until a newer reading says otherwise.
   */
  overage(now: number): void {
    const u = this.tracker.current;
    const most = spentWindowOf(u, now);
    const windows =
      u !== undefined && most !== undefined
        ? u.windows.map((w) => (w === most ? { ...w, usedPercent: Math.max(w.usedPercent, EXHAUSTED_PCT) } : { ...w }))
        : [{ usedPercent: EXHAUSTED_PCT, windowMinutes: GO_WINDOWS["rolling"]!, resetsAt: null }];
    this.tracker.observe(windows, now);
  }

  /** A spent allowance's reset (the pause's `notBefore`), off a reading at most a minute old. */
  async quotaReset(now: number): Promise<number | undefined> {
    await this.poller.refresh();
    return this.tracker.quotaReset(now);
  }
}
