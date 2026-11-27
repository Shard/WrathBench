/**
 * The run row and the run totals, as the runner's own readers produce them
 * (`run-list.ts`, `run-totals.ts`) and the viewer serves them. The viewer's
 * wire contract (`viewer/api-types.ts`) re-exports every name here, so
 * the dashboard and the viewer read them where they always did; they live on
 * this side because the runner's core and the collector never import the
 * viewer (`infra/viewer-boundary.test.ts`).
 *
 * Types only, like the contract that re-exports them: the dashboard bundles
 * them for a browser, so the only imports are types, from the import-free
 * driver registry and the inspector's wire shapes.
 */

import type { Harness } from "./drivers";
import type { ItemSample } from "@wrathbench/inspector/wire";

/**
 * The comparability tuple a run was stamped with.
 *
 * Structurally identical to `Comparability` in `runner/src/comparability.ts`,
 * which is where it is defined and validated. It is mirrored rather than
 * imported because this module is import-free by construction —
 * the dashboard bundles it for a browser and must not pull `zod`, `bun:sqlite`
 * or the prompt text in behind it. `runner/test/comparability.test.ts` pins
 * the two shapes to each other.
 */
export interface EpisodeBudgetView {
  maxTurns: number | null;
  /** Null = no ceiling (the policy freeplay lane); never the argv sentinel 0. */
  maxToolCalls: number | null;
  idleMs: number | null;
  noXpMs: number | null;
  episodeMs: number | null;
  maxSandboxRestarts: number;
}

/**
 * The episode tiers (`runner/src/episodes.ts`). Spelled out as a literal union
 * rather than imported, because this module is import-free by construction.
 */
export type EpisodeIdView = "e90" | "e360" | "probing" | "freeplay" | "deadmines" | "deadmines-solo";

/**
 * The harness a run ran under: `wrathbench` is the fixed loop,
 * `claude-code` the Claude Code CLI scaffold, `codex` the OpenAI Codex CLI
 * scaffold. The registry's own union, by a type-only import: the registry is
 * import-free too, so nothing server-side follows it into the dashboard.
 */
export type HarnessView = Harness;

export interface ComparabilityView {
  /** `git describe` of this repo's build — the same for every harness. */
  harnessVersion: string;
  promptHash: string;
  promptChars: number;
  /** Which loop owned the run. */
  harness: HarnessView;
  effort: string | null;
  budget: EpisodeBudgetView;
  /** True when an operator objective steered the run, which makes it unscored. */
  objective: boolean;
  /**
   * Whether `search_reference` served wiki coordinates. Absent on
   * runs stamped before the field existed.
   */
  wikiCoords?: boolean;
  /**
   * Present, and `false`, only on a run configured without the reference wiki
   * at all — no `search_reference`, and the prompt does not name it (issue
   * #61). Absent is the ordinary run, which has it.
   */
  wiki?: false;
  /**
   * The CLI harness's auto-compaction window (`100k`…`1M`; claude-code or codex), a key like
   * `effort`. Absent is the CLI's own `auto`, which is also every run stamped
   * before the field existed.
   */
  compactWindow?: string | null;
  /**
   * The requested routing (`runner/src/routing.ts`), a key. Absent on a run
   * with no routing to state. Never published: it names providers, and the
   * public row carries only its `RunCondition.pinned` reading.
   */
  routing?: { allowFallbacks: boolean } & Record<string, unknown>;
  /** `program` on the program loop, a key; absent on the snippet loop. */
  loop?: "program";
  /** The program loop's `yield` tool, a key; absent when off. */
  yield?: true;
  /** A local build's weights, quantisation and runtime, a key; absent on a hosted run. */
  serving?: { weights: string; quant: string; runtime: string };
  /** What is being tested; stamped only when not `hosted` (`subjectOfConfig`). */
  subject?: "hosted" | "local" | "external";
  /** An external run's declared agent, a key; absent on every run of ours. */
  agent?: { name: string | null; version: string | null };
  /**
   * Which reference bundle the run read, off the bundle's own `meta` table
   * An annotation: a text-changing rebuild ships as a patch within the
   * series, and `builtAt` marks which side of it a run read. Null when the run had no bundle;
   * absent on runs stamped before the field existed.
   */
  wikiBundle?: {
    schemaVersion: string | null;
    builtAt: string | null;
    source: string | null;
    eraCutoff: string | null;
  } | null;
  /**
   * The episode tier the run was launched under, or null for a run assembled
   * flag-by-flag. Absent on runs stamped before the field existed.
   */
  episode?: EpisodeIdView | null;
  /** True when a tier run's effective watchdogs are not its tier's. */
  episodeOverride?: boolean;
  /**
   * The worldserver's own build identity off its `/health` at launch (or
   * resume-restamp) time. Null when the module was unreachable, or for a run
   * that predates this field.
   */
  serverBuild: { build: string; startedAtMs: number } | null;
  /**
   * The model id the provider actually served (2026-08-25).
   * An annotation like `wikiBundle`, and the one field here that is observed
   * mid-episode rather than stamped at launch, so it is excluded from tuple
   * equality. Absent on runs stamped before the field existed.
   */
  resolvedModel?: string | null;
  /** A task episode's agents, characters per agent and pins (`comparability.ts`). Absent on every other run. */
  agents?: number;
  characters?: number;
  task?: { definition: string; staging?: string };
}

/** One run, as the listing and the detail endpoint report it. */
export interface RunRow {
  runId: string;
  model: string | null;
  driver: string | null;
  /** The harness tag: from the tuple, else the driver. Null when neither was recorded. */
  harness: HarnessView | null;
  /** The unscored stamp (the key keeps the old column name). Null when the run can score. */
  shakeout: string | null;
  /** The operator objective this run was steered with, or null. */
  objective: string | null;
  /**
   * The probe campaign this run was launched as a cell of, or null on anything
   * else: its own stamps, read off the run's config and never inferred, which
   * is what lets a campaign's results outlive the deletion of its store row.
   */
  campaign: string | null;
  cell: string | null;
  /** The definition version it was stamped with; null when it recorded none. Absent from a viewer that predates versions. */
  campaignVersion?: number | null;
  /** The campaign arm it ran; null on a run from before arms. */
  arm?: string | null;
  /** The roster name the fleet launched a campaign run as; null when it recorded none. */
  ref?: string | null;
  /** The image a run pod was asked to run (`WRATHBENCH_RUN_IMAGE`); null on a child-process launch. */
  image?: string | null;
  /**
   * The party a campaign run is a member of (`config.party`): its id (the
   * attempt's run-id stem), which member, and the size. Absent on every run
   * that is no party member, so no other row changes shape.
   */
  party?: PartyStampView;
  /** An extra run: past the policy target, scored like any other, never counted by the fleet. */
  extra: boolean;
  character: string | null;
  /**
   * The starting character the run was launched with (the extras cycle
   * gives free models a different one per extra run). Ids are the client's own
   * 3.3.5a race/class ids; the names are `runner/src/characters.ts`
   * resolving them, with an id no table knows rendering as its own number.
   * Null is "not recorded" — a run whose metadata predates the fields.
   */
  race: number | null;
  raceName: string | null;
  class: number | null;
  className: string | null;
  /** "Dwarf Hunter" — the compact label a row shows. Null when neither id was recorded. */
  characterLabel: string | null;
  /** Where the model was served from: "openrouter", "anthropic", the api host, or the driver. */
  platform: string | null;
  /**
   * The model id the provider actually served, where `model` is the string the
   * run was launched with. The Claude Code CLI resolves a roster alias
   * (`sonnet`) to a real id (`claude-sonnet-5`) at launch and names it only in
   * its own `init` event; an OpenAI-compatible provider names the served id on
   * each response. Stamped on the run since 2026-08-25 and back-filled by the
   * reader from the trajectory for everything older. Null is "not recorded" —
   * never the config string, which is the question this field exists to answer.
   */
  resolvedModel: string | null;
  /** The Claude Code CLI's own version, from the same record. Null on any other driver. */
  cliVersion: string | null;
  apiBase: string | null;
  /**
   * The roster entry's own `billing`, as the run recorded it at launch
   * (`RunConfig.billing`). Absent on almost every run: billing is derived. The
   * reader's verdict and the price table honour it on the openai driver only
   * (`declaredBillingOf` in `runner/src/billing.ts`).
   */
  declaredBilling?: "free" | "paid";
  /**
   * What paid for the run, as it recorded at launch (`runCredentialOf`): a v1
   * run's credential id, a 0.5 run's subscription lane (the env var NAME a
   * claude-code or codex run billed). Absent when the run recorded neither.
   * Operator-only: a public row carries neither.
   */
  credential?: string;
  lane?: string;
  /**
   * The world the run played on (`config.world`): a world per eval's id, or
   * `shared`. Absent on a run written before worlds. A label, never a key.
   * Operator-only: a public row carries none.
   */
  world?: string;
  harnessVersion: string | null;
  /**
   * The stamped comparability tuple, or null for a run whose metadata predates
   * the stamp. Null reads as "not recorded": nothing recomputes it, because a
   * prompt hash taken against today's prompt would be a fabricated claim.
   */
  comparability: ComparabilityView | null;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
  terminationDetail: string | null;
  pauseReason: string | null;
  /**
   * The freeplay run this one continues (`continued_from` in run.sqlite, and
   * `config.continuedFrom` in meta.json). A durable freeplay character is one
   * character across attempts, and this is the only link between them; null is
   * "a fresh launch", which is also what a run written before the column
   * existed and a run whose continuation was dropped both read as.
   */
  continuedFrom: string | null;
  level: number | null;
  xp: number | null;
  /** Copper on hand, and quests turned in. Null when this run's schema predates them. */
  money: number | null;
  /**
   * The newest sample's quest count on a listing row. That counter is the
   * running process's own and starts again at a resume, so `/api/run/<id>`,
   * which holds the run's series, serves the whole run's sum instead
   * (`questsAcrossRestarts`, as on `ResultRun.questsCompleted`), and so do
   * the map feed and the replay track.
   */
  questsCompleted: number | null;
  /**
   * What the character wears and carries, from the newest state sample that
   * recorded it. Null on runs that predate the `items` column, and on every
   * listing row (`/api/runs`, which reads the store's items-free aggregate):
   * only a run's own detail carries it.
   */
  items: ItemSample[] | null;
  mtime: number | null;
  bytes: number | null;
  live: boolean;
  /**
   * `store` on a session a standalone wrath-mcp recorded, read from the
   * session store beside the runs (`runner/src/session-store.ts`): it has the
   * stack's record and no model side, so no model, tokens, cost or turns, and
   * its time is its record's span (`recordSegments`). Absent on every run.
   */
  source?: "store";
  error?: string;
}

/** One `state` sample. Every field but `ts` may be absent from a given sample. */
export interface StatePoint {
  ts: number;
  level: number | null;
  xp: number | null;
  map: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  eventCount: number | null;
  lastSeq: number | null;
  /**
   * The driver turn in flight when the sample was taken; null on runs written
   * before the column existed, and on samples taken before the first turn.
   * Samples are taken on a clock, so this is first-observation, not first-reach.
   */
  turn: number | null;
  /**
   * The player frame's numbers, from the newest state sample that carried a
   * position. Optional for the reason `move` is: a run
   * recorded before the columns existed, and a snapshot published before this
   * shipped, carry none, and every reader must draw those as unobserved rather
   * than as zero. A health/maxHealth pair is whole or absent — the SDK
   * withholds a gauge until both halves are seen.
   */
  health?: number | null;
  maxHealth?: number | null;
  power?: number | null;
  maxPower?: number | null;
  /** The raw `powerType` field the client picks a power bar with. */
  powerType?: number | null;
  /** The XP bar's denominator, as the client shows it. */
  nextLevelXp?: number | null;
  /**
   * Quests turned in by the process that took the sample — it restarts at
   * zero on a resume or a sandbox restart, which is why a run's total is
   * summed across those restarts (`questsAcrossRestarts`). Optional for the
   * reason the frame's numbers are.
   */
  questsCompleted?: number | null;
}

/** Provider-reported usage for one turn, normalised across driver shapes. */
export interface ReportedUsage {
  prompt: number;
  completion: number;
  cachedRead?: number;
  cacheWrite?: number;
  /** What the provider charged for this call, in dollars (OpenRouter credits).
   * Present only when the provider reports it — the run's *actual* cost is the
   * sum of these, and nothing here estimates one. */
  cost?: number;
  /**
   * Codex only: the prompt of the turn's last API call, read by the driver
   * from the CLI's rollout. A codex turn is many calls, so `prompt` above is a
   * tally; this is the size of a context. Absent on records written before the
   * driver logged it.
   */
  lastCall?: { prompt: number; contextWindow?: number };
  /**
   * claude-code only: `completion` is the message's finished output count,
   * which the driver read off its `message_delta` (`completion_final` on the
   * record), rather than the `message_start` snapshot. Present only when true.
   */
  final?: true;
}

/** Token accounting for a whole run. */
export interface TokenTotals {
  /**
   * `reported` only when a driver actually logged provider usage, `estimated`
   * when nobody counted, and `snapshot` for a claude-code run whose completion
   * figure rests on the API's opening usage snapshots: no turn emitted a
   * `claude_result`, and its replies with only a snapshot outnumber those
   * whose finished count the driver recorded — reported, and known to
   * under-read badly. See `tokenTotals` in `run-totals.ts`.
   */
  source: "reported" | "estimated" | "snapshot";
  /**
   * The size of the latest prompt. Null for a codex run until a response
   * carries its last call's prompt (`ReportedUsage.lastCall`): a codex turn's
   * own totals are a tally of many calls, so none is shown in its place.
   */
  contextTokens: number | null;
  /** The model's window, where the last call's source said (codex rollout). */
  contextWindow?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null, never 0, when the provider never said. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /**
   * The run's model turns: its requests, except on claude-code, whose request
   * is a context handed to the CLI and whose model turns are the CLI's own
   * count, `num_turns` on its results (`claudeModelTurns` in `run-totals.ts`).
   */
  turns: number;
}

/**
 * How fast a run's model is producing: output tokens divided by the wall time
 * the model spent on its replies — the wait it was answering plus the reply
 * itself — and never by the run's elapsed time, most of which the harness
 * spends driving the game.
 *
 * The unit is one REPLY rather than one turn, because a turn is not the same
 * thing under the two drivers: the fixed loop writes a `request` and a
 * `response` per turn, while the claude-code driver hands the CLI one request
 * and logs thousands of responses under it. See `tokensPerSecond` in
 * `runner/src/run-totals.ts` for how a span is opened and closed.
 *
 * Two figures because a live run's speed now is a different question from the
 * average it has managed so far: `recent` is the last `TPS_RECENT_REPLIES`
 * measured replies, summed the same way (Σ tokens ÷ Σ seconds over the window,
 * never a mean of per-reply rates, which one short reply would dominate).
 *
 * Null on either figure when nothing in it is measurable — a run whose first
 * request is still in flight has no rate, and zero would claim it had stalled.
 */
export interface TpsFacts {
  /** Output tokens per second over every measured reply; null when there are none. */
  overall: number | null;
  /** The same over the last `TPS_RECENT_REPLIES` replies. */
  recent: number | null;
  /** Measured replies behind `overall`. Not `TokenTotals.turns`: see above. */
  replies: number;
  /** Measured replies behind `recent` (at most `TPS_RECENT_REPLIES`). */
  recentReplies: number;
}

/**
 * The tokens of a claude-code run that no `claude_result` covers: whatever a
 * session's responses used after its last result (or in a session that never
 * got one). Read off the responses' usage, so the input side is the finished
 * count and the output side the message's finished count where the driver
 * recorded one, else the API's opening snapshot — under-read (`tokenTotals`).
 * See `ClaudeCostTally` in `run-totals.ts`.
 */
export interface UnreportedUsage {
  turns: number;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  /**
   * Present, and true, only when every response counted here carried its
   * finished output count, so the output side is not under-read. Absent reads
   * as under-read, which is what every figure derived before it existed was.
   */
  outputFinal?: true;
}

/**
 * How much of a run its provider-reported cost covers: responses that did and
 * did not carry a per-call charge (OpenRouter's shape), and for a claude-code
 * run, the tokens of the turns its CLI never reported a cost for.
 */
export interface CostCoverage {
  costed: number;
  uncosted: number;
  /** Absent on a run with nothing unreported, and on totals derived before the field existed. */
  unreported?: UnreportedUsage;
}

/**
 * The fields every summarised entry carries. The open index signature is what
 * the server writes through; readers should narrow to `FeedEntry` below.
 */
export interface EntrySummary {
  /** Index of this entry in the file, 0-based. Stable; used to fetch the raw line. */
  i: number;
  t: string;
  ts: number;
  /** Byte range of the raw line, newline excluded. */
  start: number;
  end: number;
  /** True when anything in this entry was dropped or cut for display. */
  clipped?: boolean;
  [key: string]: unknown;
}

/**
 * One session: a stretch of a run during which the harness was actually
 * driving, from its first `meta` or a `resume` to a `pause` or the
 * `termination` (`runner/src/sessions.ts`, which owns the derivation). A
 * run resumed in place days later is two of these under one run id.
 */
export interface ActiveSegment {
  start: number;
  /** Null while the segment is still open — the run had not paused or ended. */
  end: number | null;
}

/**
 * What a run's zone/area milestones say about where it went.
 *
 * A **lower bound in every field**: the producer reads the state cache on
 * `stateIntervalMs` (60s) alongside `recordState`, not on the movement itself,
 * so an excursion that began and ended between two samples leaves no record at
 * all. Same convention as `results.ts`: first observation, not first reach.
 *
 * Null fields are "never recorded", never zero or false — a run from before the
 * producer existed has no `AreaFacts` at all, and `leftStartArea: null` is a run
 * whose zone was seen and whose area never was.
 */
export interface AreaFacts {
  /** The first area observed. Null when no `area` milestone was written. */
  startArea: number | null;
  /** Distinct area ids over the whole run, `startArea` included. */
  distinctAreas: number;
  /**
   * Whether the run has at least two *consecutive* observed areas both
   * outside `startArea`'s tutorial region (see `tutorialRegionOf` in
   * `runner/src/run-totals.ts`) — a sustained exit, not "any area seen that
   * differs": a lone milestone outside the region does not count, nor does
   * wandering between a newbie zone's own subzones. The pair may occur
   * anywhere in the run; a later return home does not erase it. Null when no
   * area was observed.
   */
  leftStartArea: boolean | null;
  /** The first capital zone entered, or null when none was. */
  capitalZone: number | null;
  /** How many records of each kind fed the above. */
  zoneMarks: number;
  areaMarks: number;
}

/**
 * What a run's achievement milestones say it holds (issue #8).
 *
 * `earned` is the union of the login backlog and the run's own earns, so on a
 * resumed run it is what the character holds, not what it earned this episode.
 * `points` is the last backlog record's total plus the points of every earn
 * outside that backlog — a **lower bound**, because the module serves points
 * only where it could read `Achievement.dbc`.
 *
 * Null (no `AchievementFacts` at all) is "no achievement record in this run":
 * every run before the taps were deployed, and any run whose login packet the
 * cache missed. It is never zero.
 */
export interface AchievementFacts {
  earned: number;
  points: number;
  /** The ids behind `earned`, ascending. */
  ids: number[];
}

/**
 * Flights taken, from the `taxi` milestone records.
 *
 * `flights` counts takeoffs — a `taxi` record, i.e. an accepted reply followed
 * by the taxi flag turning on — not landings, and it is a lower bound: the
 * producer samples on `stateIntervalMs`, so a hop that began and ended between
 * two samples leaves nothing behind, the same convention as `AreaFacts`.
 *
 * Null is "flights were not recorded for this run", which is not the same fact
 * as `{ flights: 0 }`. The two are told apart by the achievement records: a run
 * on a worldserver with the taps writes an `achievements_at_login` milestone
 * even when the backlog is empty, so achievement records **or** taxi records
 * prove the taps were live and zero becomes representable.
 */
export interface TaxiFacts {
  flights: number;
}

/**
 * A run's level timeline, from its `level` milestone records.
 *
 * The producer writes one mark per change of `self.level`, `from` absent on the
 * first observation of a process — so the first mark of a run is the level it
 * started at, and a **level-up is a mark that carries a `from` and climbs**.
 * `levelUps` already applies that rule; a consumer must never count `marks`.
 *
 * Distinct from the level readings the state samples carry, which say what the
 * level was at each sample: a mark says *when it changed*, with the turn in
 * flight and the XP the bar showed at that moment. It is a lower bound in the
 * usual sense — sampled on `stateIntervalMs`, so two levels gained inside one
 * interval leave one mark — and null (no `LevelUpFacts` at all) is "not
 * recorded": every run before 2026-08-29.
 */
export interface LevelUpFacts {
  /** Marks that carry a `from` and climb. Never `marks.length`. */
  levelUps: number;
  /** The first level observed, and the highest any mark named. */
  startLevel: number;
  maxLevel: number;
  /** The ends of `marks`, carried so a listing row need not walk the array. */
  first: LevelUpMark;
  last: LevelUpMark;
  /** The timeline itself, in observation order. Tens of entries at most. */
  marks: LevelUpMark[];
}

/**
 * One `level` milestone projected: the level, the level it came from, and when.
 * Distinct from `LevelMark`, which is a level reading derived from the state
 * samples and carries the cost of reaching it.
 */
export interface LevelUpMark {
  to: number;
  /** Null on the first observation of a process — a baseline, not a gain. */
  from: number | null;
  /** XP toward the next level as the bar showed it at that moment. */
  xp: number | null;
  ts: number;
  turn: number | null;
}

/**
 * A run's deaths, from the `death` / `release` / `resurrect` milestones.
 *
 * `deaths` counts the **dead windows** the producer observed opening, not the
 * health transitions: the state cache latches the corpse and the reclaim delay
 * from the death until the resurrect, so a sample landing anywhere inside the
 * window sees it and stamps the death with the cache's own timestamp. A death
 * whose whole window fell between two samples leaves nothing, and two deaths
 * with no observed resurrect between them read as one — a lower bound, the
 * convention `AreaFacts` and `TaxiFacts` already carry.
 *
 * Null is "deaths were not recorded for this run" and is not `{ deaths: 0 }`.
 * The two are told apart by the level marks: every run under this producer
 * writes one on its first sample, so a run with a level timeline and no death
 * genuinely never died. This is the job `achievements_at_login` does for
 * flights; the achievement records cannot do it here, since runs that predate
 * the death producer have them.
 */
export interface DeathFacts {
  deaths: number;
  /** Ghost-flag transitions: released to a graveyard, and resurrected. */
  releases: number;
  resurrects: number;
  /** The ends of `sites`, carried so a listing row need not walk the array. */
  first: DeathSite | null;
  last: DeathSite | null;
  /** Every death observed, in order — the death sites map replay wants. */
  sites: DeathSite[];
}

/** Where and when one death happened. */
export interface DeathSite {
  /** The death's own timestamp where the cache carried one, else the record's. */
  ts: number;
  turn: number | null;
  /**
   * The corpse, and which packet said where it is: `death_spot` is the position
   * at the moment health reached 0, `corpse_query` the server's own answer.
   * Null when neither had been observed by the sample that saw the death, or
   * when the corpse was inside a dungeon and only its entrance was known.
   */
  position: { map: number; x: number; y: number; z: number; source: "corpse_query" | "death_spot" } | null;
  /**
   * The zone/area reading at first observation. It is the death site only when
   * `released` is false — once the spirit is at the graveyard these are the
   * graveyard's ids, and `released` is what says which one a reader is holding.
   */
  zone: number | null;
  area: number | null;
  released: boolean | null;
}

/**
 * What a run learned, spent and traded, from the `spells_at_login` / `spell` /
 * `talent` / `trade` milestones.
 *
 * `spells_at_login` is the liveness witness all three share: it is written once
 * per process by the same producer, so a run that has it and no learns really
 * learned nothing, while a run from before the producer has none of the four
 * records and reads null — "not recorded" — throughout.
 */
export interface SpellFacts {
  /** Ids that entered the book after the login baseline. */
  learned: number;
  /** How many the book already carried when the run first read it. */
  atLogin: number;
  /** The learned ids, ascending. Ids only: names are the client's DBC text. */
  ids: number[];
  /** Each learn in observation order, so a page can show when. */
  marks: SpellLearnMark[];
}

export interface SpellLearnMark {
  id: number;
  ts: number;
  turn: number | null;
}

/** Talent points this run spent. Nothing about the ranks it started holding. */
export interface TalentFacts {
  /** Records written: one per rank the run watched climb. */
  spends: number;
  /** Distinct talents any of those spends touched. */
  talents: number;
  marks: TalentSpendMark[];
}

export interface TalentSpendMark {
  id: number;
  /** Points now in that talent (the wire rank plus one). */
  points: number;
  ts: number;
  turn: number | null;
}

/**
 * Completed trades. What was traded is not recorded — the SDK clears both
 * sides of the window when the trade stops being open — so this is the count
 * and the moments, which is what "first trade" needs.
 */
export interface TradeFacts {
  trades: number;
  first: TradeMarkView | null;
  last: TradeMarkView | null;
  marks: TradeMarkView[];
}

export interface TradeMarkView {
  ts: number;
  turn: number | null;
}

/** A party member's stamp as a row carries it. */
export interface PartyStampView {
  id: string;
  member: string;
  size: number;
  /**
   * The member's role (`tank`, `healer`, `damage`) and its place in the
   * party's member order, the leader at 0. Optional: a viewer that predates
   * them, and a snapshot published before them, carry neither.
   */
  role?: string;
  index?: number;
}
