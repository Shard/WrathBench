/**
 * The admin switch's wire shapes: the config API's draft routes
 * (`config-api.ts`, `drafts.ts`) and the admin page's status (`admin-api.ts`):
 * credentials, providers, the publisher, and the wrath-mcp module and store.
 * Types only, like the contract they extend (`api-types.ts`); mounted only
 * with the switch on and never on a public handle.
 */

import type { CredentialFix, CredentialHealth, CredentialWindow } from "../runner/src/credential-health";

/* ------------------------------------------------------ config drafts --- */

/*
 * The config API's draft routes (`/api/config/proposed`, `viewer/drafts.ts`).
 * Operator-only like the rest of the config API: never mounted on a public
 * handle, so the publisher never renders one. Declared here so the page's
 * client and the server share one shape.
 */

/** Catalogue list price, dollars per million tokens. */
export interface DraftPriceView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The token shape a draft's estimate is priced at: the median counted `e90`
 * of this series on the wrathbench harness, provider-reported tokens only.
 */
export interface E90TokenProfileView {
  /** The counted runs the medians are taken over; never zero (no runs, no profile). */
  runs: number;
  series: string | null;
  promptTokens: number;
  completionTokens: number;
  /** Cache reads, a subset of the prompt; a run whose provider never said reads as 0. */
  cacheReadTokens: number;
}

/** One draft as the page lists it. */
export interface DraftView {
  /** The catalogue id, which a promoted entry carries as its `model`. */
  model: string;
  /** The catalogue's display name. */
  name: string | null;
  /** When the catalogue says the model was added (epoch ms); what "newest first" sorts on. */
  created: number | null;
  /** When a fetch first proposed it. */
  firstSeen: number;
  status: "draft" | "ignored";
  ignoredAt: number | null;
  ignoredBy: string | null;
  /** Derived from the slug the way the roster derives it (`billingOf`). */
  billing: "free" | "paid";
  /** Null when the catalogue quotes no usable price. */
  price: DraftPriceView | null;
  /** List price applied to the profile. Null with no price or no profile — never a guess. */
  estimateUsd: number | null;
  /** What a promoted entry would be routed to (`routingLabel`), with no `routing` of its own. */
  routing: string;
  /** A roster name for the promote form to start from. */
  suggestedName: string;
}

/** `GET /api/config/proposed`: drafts newest first, the ignored ones apart. */
export interface DraftsResponse {
  drafts: DraftView[];
  ignored: DraftView[];
  profile: E90TokenProfileView | null;
}

/** `POST /api/config/proposed/fetch`: what one read of the catalogue changed. */
export interface DraftFetchResponse {
  /** Tool-calling models in the catalogue. */
  toolModels: number;
  /** Model ids proposed for the first time. */
  added: string[];
  /** Existing drafts whose name, date or price moved. */
  refreshed: number;
  /** Drafts dropped because the roster now runs that model. */
  removed: string[];
  /** Catalogue rows that did not parse and were left alone. */
  skipped: number;
}

/** `POST /api/config/proposed/{ignore,unignore}`: where the draft now stands. */
export interface DraftStatusResponse {
  model: string;
  status: "draft" | "ignored";
}

/** `POST /api/config/proposed/promote`. Race and class are optional, as on any entry. */
export interface DraftPromoteBody {
  model: string;
  name: string;
  tier: string;
  race?: number;
  class?: number;
}

// ------------------------------------------------------------- the admin API
// `GET /api/admin` (`admin-api.ts`), mounted only with the admin switch on.

/** One credential as the admin page shows it: the store's row, and the supervisor's status when it is up. */
export interface AdminCredentialView {
  id: string;
  provider: string;
  billing: "free" | "paid";
  enabled: boolean;
  secretEnv: string;
  slots: number;
  budget: string;
  /**
   * Whether the variable is set: its secret in the config store, else the
   * supervisor's environment; null while neither can say. Never which value.
   */
  secretSet: boolean | null;
  /** Whether the config store holds its secret (set from this page or the CLI), which wins over the environment's. */
  stored: boolean;
  /** A Codex home's re-auth from this page, as the supervisor last wrote it; null for any other credential or with none. */
  login: AdminCodexLoginView | null;
  /** Whether the chart hands the variable to the model pods (`modelKeys`); null when the viewer was not told. */
  deployed: boolean | null;
  /** Sessions on its slots now; null without a supervisor. */
  inUse: number | null;
  /** What the budget has used, as the supervisor last read it. */
  used: string | null;
  held: { scored?: string; freeplay?: string };
  lastError: { reason: string; at: number } | null;
  /**
   * Its health (`credentialHealth`, runner/src/credential-health.ts): the
   * state, why, since when and the provider's last answer. Null while no
   * supervisor is up to say, unless the store or the chart already says it is
   * switched off or its variable is not handed out.
   */
  health: CredentialHealth | null;
  /** Its usage windows as meters, as the supervisor last read them; null with none. */
  windows: CredentialWindow[] | null;
  /** What makes it well again; null when it is, or when nobody is up to say. */
  fix: CredentialFix | null;
}

/**
 * A Codex home's device login (runner/src/codex-login.ts): asked for and not
 * yet taken (`requested`), the CLI starting, waiting with the link and the
 * one-time code to enter there, or done. The code is a sign-in step the
 * operator completes, not a secret the home holds.
 */
export interface AdminCodexLoginView {
  state: "requested" | "starting" | "waiting" | "ok" | "failed";
  at: number;
  actor: string | null;
  url: string | null;
  code: string | null;
  expiresAt: number | null;
  detail: string | null;
}

export interface AdminProviderView {
  id: string;
  label: string;
  bill: "subscription" | "metered";
  /** The env var name a credential of it names: this, or this with `_<n>`. */
  envBase: string;
  /** What its variable holds: a token, a key, or a Codex home's path. */
  holds: "token" | "home" | "key";
  budgets: readonly string[];
}

/** How the deployment publishes, as the viewer was told (`infra/publish-settings.ts`, `publishViewFromEnv`). */
export interface AdminPublishView {
  /** Whether the deployment renders a publisher at all; null when the viewer was not told. */
  enabled: boolean | null;
  /** `<endpoint>/<bucket>` when the chart sets both as plain values; null when they are the Secret's. */
  target: string | null;
  region: string | null;
  virtualHostedStyle: boolean;
  delayMs: number;
  history: boolean;
  /** The publisher's last pass as its state file says, when the viewer can read it. */
  last: { flipAt: number | null; gen: string | null; held: number; scanAt: number | null; withheld: number } | null;
}

export interface AdminResponse {
  groups: { runner: boolean; evals: boolean; viewer: boolean };
  fleet: { up: boolean; heartbeatAt: number | null };
  /** The env var names the chart hands the model pods, or null when the viewer was not told. */
  modelKeys: string[] | null;
  /** Whether this viewer holds a usable store key, so a secret can be set here; else why not. */
  storeKey: { ok: true } | { ok: false; why: string };
  /**
   * Whether this viewer takes admin writes: not while it runs a different
   * build from the fleet (`write-hold.ts`, after a viewer release), and then
   * why, as every refused write says it.
   */
  writes: { ok: true } | { ok: false; why: string };
  credentials: AdminCredentialView[];
  providers: AdminProviderView[];
  publishing: AdminPublishView;
  /** The agent stack: the module as its `/health` answers the viewer, and the sessions in the store it reads. */
  wrathMcp: WrathMcpView;
  now: number;
}

/**
 * The limits the module states on `/health` (wrath-mcp/module/PROTOCOL.md,
 * "Limits"), each copied by name and only as a number (`MODULE_LIMIT_KEYS`,
 * `module-health.ts`); `0` is off.
 */
export type ModuleLimitKey =
  | "actionRate"
  | "actionBurst"
  | "eventsSubscribersPerToken"
  | "leases"
  | "connections"
  | "connectionsPerPeer"
  | "connectionsPerLease"
  | "eventsBacklogBytes";

export type ModuleLimits = Partial<Record<ModuleLimitKey, number>>;

/**
 * The module's `/health` as the viewer passes it on: an allowlist of fields,
 * each copied only when it has its type (`viewer/module-health.ts`),
 * never the body. Nothing here is a secret or names a token.
 */
export interface WrathMcpModuleView {
  /** The viewer's own route to the module, its userinfo stripped: not an address an agent uses. */
  url: string;
  /** The module's `ok`: false while the world did not load whole (a 503). */
  ok: boolean;
  worldLoaded: boolean | null;
  build: string | null;
  protocol: number | null;
  startedAtMs: number | null;
  uptimeMs: number | null;
  /** Live bench sessions; leases held. Zero or absent on a view the port secret did not open. */
  sessions: number | null;
  leases: number | null;
  limits: ModuleLimits | null;
}

/** Why `module` is null: no module URL was configured, nothing answered there, or it refused the viewer's credential. */
export type WrathMcpModuleError = "unset" | "unreachable" | "refused";

export interface WrathMcpView {
  module: WrathMcpModuleView | null;
  /** Null when `module` is not. */
  moduleError: WrathMcpModuleError | null;
  /** The env var the viewer reads the module's port secret from, and whether it is set. The value never leaves the viewer. */
  secret: { env: string; set: boolean };
  /** The session store the viewer reads (`WRATHBENCH_SESSION_STORE`), or null when it reads none. */
  store: WrathMcpStoreView | null;
}

/**
 * The store's sessions that reached the world, as the runs page lists them.
 * A session is live while its record is open (`ended` null) and its writer's
 * heartbeat is within the listing's live window.
 */
export interface WrathMcpStoreView {
  sessions: number;
  live: number;
  /** The stack each session reports (`session.json`'s `stack`), most sessions first. */
  versions: { version: string; commit: string | null; sessions: number }[];
  /** Each live session by its viewer id (never its directory's name), its character and its stack. */
  liveSessions: { id: string; character: string; version: string; commit: string | null }[];
}
