/**
 * Move a paused or ended run to another subscription lane (GitHub issue #331,
 * proposal 1; docs/RUNBOOK.md, "Moving a run to another lane").
 *
 * A run's lane is part of its identity: `meta.json`'s `config.subscription`
 * names it, and `--resume` rebuilds the config from there, so `--token-env` is
 * no override on a resume and a roster pin alone does not move a paused run.
 * This is the one supported write that does. It holds two things together
 * that a hand edit kept apart:
 *
 * - **Two writes, one invariant.** The runner bills the lane in meta.json; the
 *   fleet places and counts a pinned entry by its roster `subscription`. With
 *   `pin` both move, meta.json first: the fleet may resume the run within
 *   seconds of a roster write, and a resume that read the old meta.json would
 *   bill the old lane and write it back. The pin is validated before meta.json
 *   is touched, so after the rewrite only I/O can fail it, and a re-run of the
 *   same command applies a pin that is still owed. Without `pin`, an entry
 *   that already pins another lane refuses the move rather than diverge.
 * - **A record.** Each move appends `{ from, to, at, actor, note }` to the
 *   run's `laneHistory` (top level, never `config`; operator-only like
 *   `subscriptionUsage`).
 *
 * Refused, writing nothing: a run with a live owner (`liveOwnerOf`, the check
 * `run.ts --resume` and the roster make) or with no verdict at all (the fleet
 * resumes that as `offline` on its next tick); a lane `policy.subscriptions`
 * does not list; a lane of another kind than the run's driver bills; and any
 * driver whose lane is not `movable` (drivers.ts) — today everything but the
 * Claude CLI, whose lane is a bare credential.
 *
 * meta.json is rewritten atomically — a temp file in the same directory, then
 * a rename — in its own indentation and trailing newline, with its mode bits
 * (and, where the process may, its owner) kept.
 */

import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFleet, rosterModels, type FleetConfig } from "../../infra/run-fleet-config";
import { isTokenEnvName } from "./config";
import type { ConfigStore } from "./config-store";
import { DEFAULT_DRIVER, driverEntry, laneHoldsOf } from "./drivers";
import { liveOwnerOf, matchesRoster, readRunFact } from "./models";
import type { LaneMove } from "./trajectory";
import { ARCHIVE_DIR } from "../viewer/archive-dir";

/** A move refused before anything was written. */
export class LaneMoveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneMoveRefused";
  }
}

/** meta.json was moved, and the roster pin that should follow it was not written. */
export class LanePinFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanePinFailed";
  }
}

export interface MoveLaneOptions {
  runsDir: string;
  runId: string;
  /** The lane variable NAME to move to (`CLAUDE_CODE_OAUTH_TOKEN_2`). */
  to: string;
  /** Also pin the run's roster entry to `to`, after meta.json. */
  pin: boolean;
  actor: string;
  note: string;
  store: ConfigStore;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface MoveLaneResult {
  from: string;
  to: string;
  /** Whether meta.json was rewritten: false when it already named `to` and only the pin was owed. */
  moved: boolean;
  /** The roster key pinned (`roster/sonnet`), or null. */
  pinned: string | null;
  /** The roster entry the run belongs to, when exactly one does. */
  ref: string | null;
  /** How many moves `laneHistory` holds now. */
  history: number;
  /** Things the operator should know that did not stop the move. */
  warnings: string[];
}

type MetaDoc = Record<string, unknown> & { config: Record<string, unknown>; laneHistory?: unknown };

export function moveLane(o: MoveLaneOptions): MoveLaneResult {
  const now = o.now ?? Date.now;
  const note = o.note.trim();
  if (note.length === 0) throw new LaneMoveRefused("a lane move needs --note: laneHistory records why the run moved");
  if (!isTokenEnvName(o.to)) throw new LaneMoveRefused(`${JSON.stringify(o.to)} is not an env var name — name the variable that holds the lane's credential, never the credential`);

  const dir = join(o.runsDir, o.runId);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    if (existsSync(join(o.runsDir, ARCHIVE_DIR, o.runId, "meta.json"))) {
      throw new LaneMoveRefused(`run ${o.runId} is archived; nothing resumes an archived run, so there is no lane to move`);
    }
    throw new LaneMoveRefused(`no meta.json for run ${o.runId} under ${o.runsDir}`);
  }
  const text = readFileSync(metaPath, "utf8");
  const meta = parseMeta(text, o.runId);

  // The driver's facts, never its name.
  const driverName = typeof meta.config["driver"] === "string" ? meta.config["driver"] : DEFAULT_DRIVER;
  const entry = driverEntry(driverName);
  if (entry === undefined) throw new LaneMoveRefused(`run ${o.runId} names driver ${driverName}, which this build does not know`);
  const lane = entry.lane;
  if (lane === undefined) throw new LaneMoveRefused(`run ${o.runId} is a ${entry.id} run, which bills no subscription lane — there is nothing to move`);
  if (!lane.movable) {
    throw new LaneMoveRefused(
      `run ${o.runId} is a ${entry.id} run: its lane holds more than a credential (the CLI's own threads), so moving it is not supported`,
    );
  }
  if (laneHoldsOf(o.to) !== lane.holds) throw new LaneMoveRefused(`${o.to} is not a ${entry.id} lane`);

  const fleet = parsedFleet(o.store, o.env);
  if (!fleet.policy.subscriptions.includes(o.to)) {
    throw new LaneMoveRefused(`${o.to} is not in policy.subscriptions (${fleet.policy.subscriptions.join(", ")}) — list it there first`);
  }

  const from = typeof meta.config["subscription"] === "string" ? meta.config["subscription"] : lane.defaultEnv;

  // Not live, and paused or ended: the same owner check a resume makes, then a verdict.
  refuseOwned(o.runsDir, o.runId, now());
  const fact = readRunFact(o.runsDir, o.runId, now());
  if (fact === null) throw new LaneMoveRefused(`run ${o.runId}: meta.json does not read as a run (no episode or no model)`);
  if (fact.pause === null && fact.terminationReason === null) {
    throw new LaneMoveRefused(
      `run ${o.runId} is neither paused nor ended — a run with no verdict is resumed as offline on the fleet's next tick; pause it first (roster idle "none")`,
    );
  }

  // The roster entry the run is the fleet's for, matched as the fleet matches it.
  const owners = rosterModels(fleet.roster).filter((r) => matchesRoster(fact, r));
  const ref = owners.length === 1 ? owners[0]!.name : null;
  const key = ref === null ? null : `roster/${ref}`;
  const rawPin = key === null ? undefined : pinOf(o.store.get(key));

  if (o.pin && key === null) {
    throw new LaneMoveRefused(
      owners.length === 0
        ? `--pin: no roster entry is run ${o.runId}'s (model ${fact.model}${fact.effort !== null ? `, effort ${fact.effort}` : ""}) — nothing written`
        : `--pin: ${owners.map((r) => `roster/${r.name}`).join(" and ")} all match run ${o.runId}; pin the right one with \`config patch\` — nothing written`,
    );
  }
  if (!o.pin && rawPin !== undefined && rawPin !== o.to) {
    throw new LaneMoveRefused(
      `${key} pins ${rawPin}: the fleet would count the run against ${rawPin} while it bills ${o.to}. Pass --pin to move the pin with it — nothing written`,
    );
  }

  const pinOwed = o.pin && rawPin !== o.to;
  if (from === o.to && !pinOwed) {
    throw new LaneMoveRefused(`run ${o.runId} is already on ${o.to}${o.pin ? ` and ${key} pins it` : ""} — nothing written`);
  }
  // Validated now, so that once meta.json has moved only I/O can stop the pin.
  if (pinOwed) {
    try {
      o.store.checkPatch(key!, { subscription: o.to });
    } catch (e) {
      throw new LaneMoveRefused(`--pin: ${key} would be refused: ${e instanceof Error ? e.message : String(e)} — nothing written`);
    }
  }

  const warnings: string[] = [];
  let history = Array.isArray(meta.laneHistory) ? meta.laneHistory.length : 0;
  const moved = from !== o.to;
  if (moved) {
    const move: LaneMove = { from, to: o.to, at: now(), actor: o.actor, note };
    meta.config["subscription"] = o.to;
    meta.laneHistory = [...(Array.isArray(meta.laneHistory) ? meta.laneHistory : []), move];
    history += 1;
    const out = formatLike(text, meta);
    // The last look before the rename: a resume that started since would
    // rewrite meta.json itself, and the rename must not clobber that.
    refuseOwned(o.runsDir, o.runId, now());
    if (readFileSync(metaPath, "utf8") !== text) throw new LaneMoveRefused(`run ${o.runId}: meta.json changed while the move was prepared — nothing written; run it again`);
    writeAtomic(metaPath, out);
    const after = liveOwnerOf(o.runsDir, o.runId, now());
    if (after !== null) {
      warnings.push(`run ${o.runId} gained an owner as it moved (${after}); once it pauses, check its meta.json still names ${o.to}`);
    }
  }

  let pinned: string | null = null;
  if (pinOwed) {
    try {
      o.store.patch(key!, { subscription: o.to }, { actor: o.actor, note: `move-lane ${o.runId}: ${note}` });
      pinned = key;
    } catch (e) {
      throw new LanePinFailed(
        `meta.json ${moved ? "moved to" : "already names"} ${o.to}, but ${key} was not pinned: ${e instanceof Error ? e.message : String(e)}. ` +
          `The run bills ${o.to} while the fleet counts ${key} against ${rawPin ?? "the lane it places it on"}; run the same command again to apply the pin`,
      );
    }
  }
  return { from, to: o.to, moved, pinned, ref, history, warnings };
}

function parseMeta(text: string, runId: string): MetaDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new LaneMoveRefused(`run ${runId}: meta.json does not parse (${e instanceof Error ? e.message : String(e)})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new LaneMoveRefused(`run ${runId}: meta.json is not an object`);
  const config = (raw as { config?: unknown }).config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new LaneMoveRefused(`run ${runId}: meta.json has no config`);
  return raw as MetaDoc;
}

function parsedFleet(store: ConfigStore, env: Record<string, string | undefined> | undefined): FleetConfig {
  if (store.isEmpty()) throw new LaneMoveRefused("the config store is empty — there is no policy.subscriptions to check the lane against");
  try {
    return parseFleet(store.render(), env !== undefined ? { env } : {});
  } catch (e) {
    throw new LaneMoveRefused(`the config store does not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function refuseOwned(runsDir: string, runId: string, now: number): void {
  const owner = liveOwnerOf(runsDir, runId, now);
  if (owner !== null) throw new LaneMoveRefused(`run ${runId} has a live owner: ${owner} — pause it first (roster idle "none")`);
}

function pinOf(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const v = (row as { subscription?: unknown }).subscription;
  return typeof v === "string" ? v : undefined;
}

/**
 * `value` serialised the way `original` was: the same indent unit (the first
 * indented line's leading whitespace; none for a one-line document) and the
 * same trailing newline, or its absence.
 */
export function formatLike(original: string, value: unknown): string {
  const indent = /\n([ \t]+)\S/.exec(original)?.[1] ?? "";
  return `${JSON.stringify(value, null, indent)}${original.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Replace `path` with `content` by a rename from a temp file in the same
 * directory, so a reader sees the old file or the new one and never half of
 * either. The temp file starts owner-only (meta.json holds the run's session
 * token) and takes the old file's mode bits explicitly: a create's mode is cut
 * by the umask, which is how a hand rewrite lost the group-write bit. The
 * owner and group are carried over where the process may set them.
 */
export function writeAtomic(path: string, content: string): void {
  const st = statSync(path);
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const made = statSync(tmp);
    if (made.uid !== st.uid || made.gid !== st.gid) {
      try {
        chownSync(tmp, st.uid, st.gid);
      } catch {
        // Not ours to give away; the mode bits below still hold.
      }
    }
    chmodSync(tmp, st.mode & 0o7777);
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(tmp, { force: true });
  }
}
