/**
 * The driver registry: one entry per driver, holding every per-driver fact the
 * runner, the viewer and the fleet act on. Adding a harness is one adapter
 * (`driver-adapters.ts`), one entry here and its fixtures (runner/README.md,
 * "The driver contract"); everything else reads the entry, and
 * `driver-scatter.test.ts` fails on a driver's name written as a literal in
 * the runner, the viewer or the fleet outside the registry and the adapters.
 *
 * Import-free on purpose: the viewer, `infra/` and the dashboard's wire types
 * read it, and none of them may pull an adapter in behind it. Facts only —
 * how a driver runs a turn is the adapter's.
 *
 * The order of `DRIVERS` is load-bearing: every list derived from it (the
 * harnesses, the concurrency keys, the roster's driver vocabulary, the
 * compaction-window drivers) reads in that order, and refusals print them.
 */

/**
 * Every driver a run can be started with. `stub` and `reference` never score:
 * neither is a model (`stamp`).
 */
export const DRIVERS = ["openai", "claude-code", "codex", "pi", "stub", "reference"] as const;
export type Driver = (typeof DRIVERS)[number];

/** The driver of a run, roster entry or record that names none. */
export const DEFAULT_DRIVER: RosterDriver = "openai";

export function isDriver(raw: string): raw is Driver {
  return (DRIVERS as readonly string[]).includes(raw);
}

/**
 * The harness: what owns the agent loop and the context management.
 *
 *  - `wrathbench`: our fixed loop, with the fixed context policy
 *    (docs/METHODOLOGY.md "Context policy"). The `openai`, `stub` and
 *    `reference` drivers run under it.
 *  - `claude-code`: the Claude Code CLI scaffold, with its own history and
 *    compaction. There is no separate driver under it — the CLI is the
 *    transport.
 *  - `codex`: the OpenAI Codex CLI scaffold (operator, 2026-09-05), likewise
 *    its own history and its own compaction. A separate group from
 *    `claude-code` rather than one "CLI" group, because each scaffold is a
 *    different unversioned summarizer sitting inside the harness.
 *  - `pi`: the pi coding-agent CLI (operator, 2026-10-20), its own history
 *    and its own compaction, on a metered OpenAI-compatible endpoint.
 *    Probe-only until the operator promotes it (`DriverEntry.probeOnly`).
 *
 * A tag on every run, not a partition and not a scoring penalty (operator,
 * 2026-10-16): rows of every harness share the charts, and no row mixes two
 * harnesses because a model id runs under one harness across the roster
 * (`harnessClash`, config.ts). Distinct from `harnessVersion`, which is the git
 * describe of *this* repo and applies to all three (the SDK and MCP surface
 * each CLI drives is ours). Spelled out rather than derived, because the
 * comparability schema (`z.enum`) needs the literal tuple; `drivers.test.ts`
 * holds it to the entries.
 */
export const HARNESSES = ["wrathbench", "claude-code", "codex", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

// ------------------------------------------------------------ lanes, stamps

/**
 * The default subscription lane: the env var the Claude Code CLI itself knows,
 * and the only one a run names when nothing says otherwise. A second
 * subscription is a second variable (`CLAUDE_CODE_OAUTH_TOKEN_2`), never a
 * second spelling of this one — see `RunConfig.subscription`.
 */
export const DEFAULT_CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * The `codex` driver's default lane: the env var the Codex CLI itself reads
 * for its home directory, whose `auth.json` is the ChatGPT login. The lane
 * variable names a DIRECTORY, not a token — one directory per subscription,
 * shared by every run on that lane and never copied per run: a copied
 * `auth.json` carries a refresh token that whichever process refreshes first
 * consumes, and the other side then fails with "refresh token was already
 * used" (observed on this host, 2026-09-05). A second subscription is a second
 * variable (`CODEX_HOME_2`) pointing at a second directory.
 */
export const DEFAULT_CODEX_HOME_ENV = "CODEX_HOME";

/**
 * Whether a lane variable NAME is a Codex home (`CODEX_HOME`, `CODEX_HOME_2`)
 * rather than a Claude token. `policy.subscriptions` lists both kinds, because
 * a roster entry may only pin a lane that list names, so the kind is read off
 * the name, which is the convention the two defaults already set.
 */
export function isCodexHomeEnvName(name: string): boolean {
  return new RegExp(`^${DEFAULT_CODEX_HOME_ENV}(_[0-9]+)?$`).test(name);
}

/** What a lane variable NAME holds, read off the name (`isCodexHomeEnvName`). */
export function laneHoldsOf(name: string): LaneHolds {
  return isCodexHomeEnvName(name) ? "home" : "token";
}

/**
 * The stamp carried by meta.json, run.sqlite and the timeline for a scripted
 * stub run. The storage key is still named `shakeout` (trajectory.ts); the
 * word now only ever means "this run can never score".
 */
export const STUB_STAMP = "unscored (scripted stub)";

/**
 * The stamp carried by a scripted reference run (`--driver reference`). It is
 * a labelled line on the ladder, never a row: outside every comparability
 * group, never counted toward a target, never in the row order (operator,
 * 2026-10-19; docs/METHODOLOGY.md, "Scoring").
 */
export const REFERENCE_STAMP = "unscored (scripted reference)";

// ------------------------------------------------------------------ entries

/** A lane variable holds a secret token (redacted, a pod secret) or a home directory's path (a plain value and a mounted volume). */
export type LaneHolds = "token" | "home";

/** A driver that bills a flat subscription: how its lane is named, kept and placed. */
export interface SubscriptionLane {
  /** The lane's spelling is `<key>:<ENV NAME>`: the gate's, the usage sidecar's and the concurrency cap's. */
  key: string;
  /** The lane a run names when nothing says otherwise. */
  defaultEnv: string;
  holds: LaneHolds;
  /**
   * True when the fleet places a policy job among the policy's lanes of this
   * kind and gates it on all of them (Claude subscriptions); false when a
   * policy job runs on the default lane unless a job pins one (Codex homes).
   */
  placed: boolean;
  /**
   * Whether the operator may move a paused or ended run of this driver to
   * another lane of its kind (`move-lane`, runner/src/move-lane.ts). True only
   * where the lane is a credential and nothing else: the run's own state names
   * no account, and a resume starts the CLI a fresh conversation, so the next
   * segment simply bills the other subscription. A home lane is not that — it
   * holds the CLI's own thread rollouts — so it stays where it started until
   * resume semantics across homes are checked.
   */
  movable: boolean;
  /** The dry run's endpoint line for a run on `env` (the lane as the spec names it, absent for the default). */
  describe(env: string | undefined): string;
  /** Why a launch in the fleet container cannot start when `env` is unset there. */
  containerRefusal(env: string): string;
}

/** How a driver's runs are priced (runner/viewer/pricing.ts). */
export interface DriverCost {
  /**
   * Where a run's actual cost comes from: the provider's charge per response,
   * the CLI's own as-if-metered figure (with unreported turns backfilled), or
   * nowhere — a run that reports none is only ever estimated.
   */
  reported: "provider" | "cli" | "none";
  /** The price table its runs read: the synced catalogue, or the hand-kept Claude table. */
  table: "synced" | "claude";
  /**
   * The catalogue vendor a bare model slug is priced under (`openai/<slug>`),
   * read as as-if-metered because the lane bills a subscription. Absent where
   * the slug is already the catalogue's id.
   */
  vendor?: string;
  /**
   * A model id without this prefix is a CLI alias (`sonnet`) resolved only
   * when the CLI starts, so no roster price check can say what it will be
   * served.
   */
  modelPrefix?: string;
}

export interface DriverEntry {
  id: Driver;
  harness: Harness;
  /**
   * `loop`: our fixed loop runs the turns and the driver answers one model
   * request at a time (`ChatAdapter`). `scaffold`: a CLI runs its own turn
   * loop and history and reaches our tools over the loopback MCP listener; a
   * resume starts it a fresh conversation (`resumedFresh`).
   */
  kind: "loop" | "scaffold";
  /** The unscored stamp of a driver that is not a model; a model's driver has none. */
  stamp?: string;
  /**
   * Plays the scripted reference program's route (`reference-program.ts`)
   * instead of a model: the route's id is its model, the route's start its
   * race and class (`resolveReferenceLaunch`), and nothing — objective,
   * continuation, campaign — can steer it (`loadRunConfig`).
   */
  route?: boolean;
  /** Whether a roster entry may name it. */
  roster: boolean;
  /** Why a roster entry may never name it, said by name rather than as an unknown driver. */
  rosterRefusal?: string;
  /** Whether `policy.maxConcurrent` may cap it under its own id. */
  capKey: boolean;
  /**
   * Reaches an OpenAI-compatible endpoint by base and key: it takes `apiBase`,
   * `apiKeyEnv` and a declared `billing`, the provider table guards the pair,
   * a run pod keeps that one key, and a free-platform cap or an OpenCode Go
   * allowance applies to it.
   */
  endpoint: boolean;
  /**
   * Sends OpenRouter's provider routing (`routing.ts`) on its own requests.
   * Only a driver that builds the request body itself can: a CLI that
   * reaches an endpoint (pi) sends what the CLI sends, so a routing block on
   * its entry would be config that does nothing, and is refused.
   */
  routing: boolean;
  /**
   * An endpoint CLI that reaches the run's base through a provider of its own
   * catalogue, which the key's row in the provider table names (`piProvider`,
   * providers.ts): a key with no such provider is refused as the roster entry,
   * so its campaign squares are parked rather than spent on failed launches.
   * Absent on every driver that sends its own requests.
   */
  cliProvider?: true;
  /**
   * Runs only as a probe-campaign arm until the operator promotes it
   * (docs/METHODOLOGY.md, "Harness and driver are separate words"). Its
   * roster entry exists for a campaign to name in an assignment; the policy
   * schedules no scored or freeplay run of it, a queue job outside a campaign
   * may not name it, and it is outside `harnessClash`, since none of its runs
   * is in a scored lane. Promoting it is turning this off.
   */
  probeOnly: boolean;
  /** The subscription it bills, for a driver that bills one. */
  lane?: SubscriptionLane;
  /**
   * Who pays: per call (`metered`, judged by the billing rules), a flat
   * subscription, or nobody (no model, no provider). `billingOf` and
   * `runBilling` read a subscription differently on purpose (billing.ts).
   */
  bill: "metered" | "subscription" | "none";
  cost: DriverCost;
  /** The roster's model-family rule: whether it carries claude models only, or none, and the refusal either way. */
  claudeModels?: { only: boolean; refusal: string };
  /** Whether the scaffold has an auto-compaction window a run can set (`compactWindow`). */
  compactWindow: boolean;
  /**
   * Whether each `run_snippet` result ends with what changed since the
   * previous one (`sandbox/snippet-delta.ts`), and the prompt says so. On for
   * claude-code only (operator, 2026-10-21): a CLI scaffold runs one long
   * driver turn and sees the HUD at its ends only, while the fixed loop
   * rebuilds the HUD every turn and so never takes it. Turning it on for
   * another scaffold is this flag and nothing else; the scaffold adapters
   * and the prompt both read it.
   */
  snippetDelta: boolean;
  /**
   * How usage reaches the trajectory: one figure per model `response`; a
   * response's opening snapshot whose finished count arrives on the turn's
   * result (`turn-snapshot`); or a turn that is one whole CLI exec, its
   * figures tallies of many calls and its context the last call's prompt
   * (`exec-tally`).
   */
  usage: "response" | "turn-snapshot" | "exec-tally";
  /** Whether its CLI leaves session files (rollouts) in the lane's home, which the fleet sweeps. */
  rollouts: boolean;
  /** Run-pod template volumes only this driver mounts; every other driver's pod has them removed. */
  podVolumes: readonly string[];
}

const FIXED_LOOP_COST: DriverCost = { reported: "provider", table: "synced" };

/**
 * The registry. Keyed by id; `DRIVER_LIST` is the same entries in `DRIVERS`
 * order. `as const` so the roster's driver union derives from `roster`.
 */
export const DRIVER_TABLE = {
  openai: {
    id: "openai",
    harness: "wrathbench",
    kind: "loop",
    roster: true,
    capKey: true,
    endpoint: true,
    routing: true,
    probeOnly: false,
    bill: "metered",
    cost: FIXED_LOOP_COST,
    claudeModels: {
      only: false,
      refusal: "roster policy — claude models run only via the claude-code driver, never through an openai-driver entry",
    },
    compactWindow: false,
    snippetDelta: false,
    usage: "response",
    rollouts: false,
    podVolumes: [],
  },
  "claude-code": {
    id: "claude-code",
    harness: "claude-code",
    kind: "scaffold",
    roster: true,
    capKey: true,
    endpoint: false,
    routing: false,
    probeOnly: false,
    lane: {
      key: "claude-code",
      defaultEnv: DEFAULT_CLAUDE_TOKEN_ENV,
      holds: "token",
      placed: true,
      movable: true,
      describe: () => "claude CLI subscription",
      containerRefusal: (env) =>
        `${env} is not visible to the fleet container — put it in /wrathbench/.env ` +
        "(`claude setup-token`), it is loaded by Bun there and never passed via argv",
    },
    bill: "subscription",
    cost: { reported: "cli", table: "claude", modelPrefix: "claude-" },
    claudeModels: { only: true, refusal: "roster policy — the claude-code driver carries claude models only" },
    compactWindow: true,
    snippetDelta: true,
    usage: "turn-snapshot",
    rollouts: false,
    podVolumes: [],
  },
  codex: {
    id: "codex",
    harness: "codex",
    kind: "scaffold",
    roster: true,
    capKey: true,
    endpoint: false,
    routing: false,
    probeOnly: false,
    lane: {
      key: "codex",
      defaultEnv: DEFAULT_CODEX_HOME_ENV,
      holds: "home",
      placed: false,
      movable: false,
      describe: (env) => `codex CLI subscription, lane ${env ?? DEFAULT_CODEX_HOME_ENV}`,
      containerRefusal: (env) =>
        `${env} is not visible to the fleet container — put it in /wrathbench/.env as the path of a ` +
        "logged-in Codex home (`codex login`); it is loaded by Bun there and never passed via argv",
    },
    bill: "subscription",
    cost: { reported: "none", table: "synced", vendor: "openai" },
    // The Codex CLI is a ChatGPT-subscription lane: OpenAI's catalogue only.
    claudeModels: { only: false, refusal: "roster policy — the codex driver carries no claude models" },
    compactWindow: true,
    snippetDelta: false,
    usage: "exec-tally",
    rollouts: true,
    podVolumes: ["codex-home"],
  },
  // The pi coding-agent CLI on a metered endpoint (`adapter-pi.ts`): a base and
  // a key like the fixed loop, priced from its tokens by the hand-held provider
  // rows, never by the figure pi's own catalogue puts on them. A labelled
  // harness, probe-only until the operator promotes it (operator, 2026-10-20).
  pi: {
    id: "pi",
    harness: "pi",
    kind: "scaffold",
    roster: true,
    capKey: true,
    endpoint: true,
    routing: false,
    cliProvider: true,
    probeOnly: true,
    bill: "metered",
    cost: { reported: "none", table: "synced" },
    claudeModels: {
      only: false,
      refusal: "roster policy — claude models run only via the claude-code driver, never through a pi-driver entry",
    },
    compactWindow: true,
    snippetDelta: false,
    usage: "response",
    rollouts: false,
    podVolumes: [],
  },
  stub: {
    id: "stub",
    harness: "wrathbench",
    kind: "loop",
    stamp: STUB_STAMP,
    roster: false,
    capKey: true,
    endpoint: false,
    routing: false,
    probeOnly: false,
    bill: "metered",
    cost: FIXED_LOOP_COST,
    compactWindow: false,
    snippetDelta: false,
    usage: "response",
    rollouts: false,
    podVolumes: [],
  },
  // The scripted reference plays through the fixed loop, so its snippets reach
  // the sandbox exactly as a model's do (`reference-adapter.ts`). Launched by
  // hand once per harness series; the policy never schedules or caps one
  // (docs/EPISODES.md, "The scripted reference run").
  reference: {
    id: "reference",
    harness: "wrathbench",
    kind: "loop",
    stamp: REFERENCE_STAMP,
    route: true,
    roster: false,
    rosterRefusal: "driver reference is the scripted reference run — launched by hand on PROBE, never a roster entry",
    capKey: false,
    endpoint: false,
    routing: false,
    probeOnly: false,
    bill: "none",
    cost: FIXED_LOOP_COST,
    compactWindow: false,
    snippetDelta: false,
    usage: "response",
    rollouts: false,
    podVolumes: [],
  },
} as const satisfies Record<Driver, DriverEntry>;

export const DRIVER_LIST: readonly DriverEntry[] = DRIVERS.map((d) => entryOf(d));

// ------------------------------------------------------------------ lookups

/** The entry a stored or configured name refers to; undefined for an absent or unknown one. */
export function driverEntry(name: unknown): DriverEntry | undefined {
  return typeof name === "string" && isDriver(name) ? entryOf(name) : undefined;
}

/** A known driver's entry, typed as the interface rather than as its literal. */
export function entryOf(driver: Driver): DriverEntry {
  return DRIVER_TABLE[driver];
}

export const HARNESS_OF_DRIVER: Readonly<Record<Driver, Harness>> = Object.fromEntries(
  DRIVER_LIST.map((d) => [d.id, d.harness]),
) as Record<Driver, Harness>;

export function harnessOf(driver: Driver): Harness {
  return DRIVER_TABLE[driver].harness;
}

/**
 * The first driver, in `DRIVERS` order, that runs under a harness: how a
 * stored row that kept only its harness tag is read for a driver's facts.
 * Undefined for a name that is not a harness.
 */
export function harnessDriver(name: unknown): DriverEntry | undefined {
  return DRIVER_LIST.find((d) => d.harness === name);
}

/** Whether either name a stored row carries — driver or harness — has the fact. */
export function eitherHas(
  run: { driver?: string | null | undefined; harness?: string | null | undefined },
  fact: (d: DriverEntry) => boolean,
): boolean {
  const byDriver = driverEntry(run.driver);
  const byHarness = harnessDriver(run.harness);
  return (byDriver !== undefined && fact(byDriver)) || (byHarness !== undefined && fact(byHarness));
}

/** The drivers a roster entry may name, in `DRIVERS` order. */
export type RosterDriver = { [K in Driver]: (typeof DRIVER_TABLE)[K]["roster"] extends true ? K : never }[Driver];
export const ROSTER_DRIVERS: readonly RosterDriver[] = DRIVERS.filter(isRosterDriver);

export function isRosterDriver(raw: string): raw is RosterDriver {
  return driverEntry(raw)?.roster === true;
}

/**
 * The one driver whose runs the fleet places among several subscription lanes
 * (`SubscriptionLane.placed`). Its id is also the concurrency key every such
 * session counts against, whichever lane bills it.
 */
export const PLACED_LANE_DRIVER: Driver = DRIVER_LIST.find((d) => d.lane?.placed === true)!.id;

/** Whether a stored or configured driver name — absent is the default — is probe-only (`DriverEntry.probeOnly`). */
export function isProbeOnlyDriver(name: unknown): boolean {
  return driverEntry(name ?? DEFAULT_DRIVER)?.probeOnly === true;
}

/** Why a probe-only driver's entry is outside the scored and freeplay lanes, said by name. */
export function probeOnlyRefusal(driver: string): string {
  return `driver ${driver} is probe-only: it runs only as a probe-campaign arm until the operator promotes it (docs/METHODOLOGY.md, "Harness and driver are separate words")`;
}

/** Every run-pod template volume some driver mounts; a pod keeps only its own driver's. */
export const DRIVER_POD_VOLUMES: readonly string[] = [...new Set(DRIVER_LIST.flatMap((d) => d.podVolumes))];

/** The plain env vars naming a home lane's directory: a credential's address, passed only to the driver that reads it. */
export const HOME_LANE_ENVS: readonly string[] = DRIVER_LIST.flatMap((d) => (d.lane?.holds === "home" ? [d.lane.defaultEnv] : []));
