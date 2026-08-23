#!/usr/bin/env bun
/**
 * Minimal terminal timeline viewer (PHASE-0): enough to read a stall in a few
 * minutes. `bun runner/src/timeline.ts <run-id> [--runs-dir data/runs]`
 */

import { join } from "node:path";
import { normalizePauseReason, readUnscoredStamp } from "./config";
import { readMeta, readTrajectory, Trajectory, type TrajectoryRecord } from "./trajectory";

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
}

const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(values: number[]): string {
  if (values.length === 0) return "(no data)";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => SPARK[Math.min(7, Math.floor(((v - min) / span) * 8))]).join("");
}

export function renderTimeline(runDir: string, runId: string): string {
  const meta = readMeta(runDir);
  const records = readTrajectory(runDir);
  const lines: string[] = [];

  const trajectory = new Trajectory(runDir);
  const row = trajectory.runRow(runId);
  const stateRows = trajectory.stateRows(runId);
  trajectory.close();

  const shakeout = readUnscoredStamp((meta?.shakeout ?? row?.["shakeout"]) as string | null | undefined);
  if (typeof shakeout === "string" && shakeout.length > 0) {
    // First and last thing the reader sees: this run is not a score.
    lines.push("!! ".repeat(8).trim());
    lines.push(`!! ${shakeout.toUpperCase()} — NOT A SCORED RESULT`);
    lines.push("!! ".repeat(8).trim());
    lines.push("");
  }
  lines.push(`run:        ${runId}`);
  if (meta !== null) {
    lines.push(`harness:    ${meta.harnessVersion}`);
    // `adapter` is the pre-driver name for the same thing; old runs only have it.
    const driver = meta.config.driver ?? meta.config.adapter;
    lines.push(`driver:     ${driver}${meta.config.model !== undefined ? ` (${meta.config.model})` : ""}`);
    lines.push(`character:  ${meta.config.character} (race ${meta.config.race}, class ${meta.config.class})`);
    lines.push(`started:    ${fmtTs(meta.startedAt)}`);
  }
  const endedAt = row?.["ended_at"] as number | null | undefined;
  if (meta !== null && typeof endedAt === "number") {
    lines.push(`ended:      ${fmtTs(endedAt)} (${fmtDur(endedAt - meta.startedAt)})`);
  }
  const reason = row?.["termination_reason"] as string | null | undefined;
  const pause = row?.["pause_reason"] as string | null | undefined;
  if (typeof reason === "string") {
    const detail = row?.["termination_detail"];
    lines.push(`ended as:   ${reason}${typeof detail === "string" ? ` — ${detail}` : ""}`);
  } else if (typeof pause === "string") {
    lines.push(`paused as:  ${normalizePauseReason(pause)} (resumable)`);
  } else {
    lines.push("ended as:   (still running or never finalised)");
  }
  lines.push("");

  // level / XP curve from periodic state
  // Rows before a session exists carry no level; they are not level-0 data.
  const levels = stateRows
    .map((r) => r["level"] as number | null)
    .filter((l): l is number => typeof l === "number" && l > 0);
  lines.push(`state lines: ${stateRows.length}`);
  if (stateRows.length > 0) {
    lines.push(`level:      ${levels[0] ?? "?"} -> ${levels[levels.length - 1] ?? "?"}   ${sparkline(levels)}`);
    const last = stateRows[stateRows.length - 1]!;
    const map = last["map"];
    if (map !== null && map !== undefined) {
      lines.push(`last pos:   map ${String(map)} (${String(last["x"])}, ${String(last["y"])}, ${String(last["z"])})`);
    }
    // Columns added later; a run.sqlite written before them has neither.
    const money = last["money"];
    if (typeof money === "number") lines.push(`money:      ${money}c`);
    const quests = last["quests_completed"];
    if (typeof quests === "number") lines.push(`quests:     ${quests} turned in`);
  }

  // events per minute, snippet counts, errors from the JSONL
  const byType = new Map<string, number>();
  let eventsServed = 0;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  const errors: TrajectoryRecord[] = [];
  for (const r of records) {
    byType.set(r.t, (byType.get(r.t) ?? 0) + 1);
    if (r.ts > 0) {
      firstTs = Math.min(firstTs, r.ts);
      lastTs = Math.max(lastTs, r.ts);
    }
    if (r.t === "events_served" && typeof r["count"] === "number") eventsServed += r["count"];
    if ((r.t === "snippet_result" || r.t === "tool_result") && r["isError"] === true) errors.push(r);
    if (r.t === "harness") errors.push(r);
  }
  const spanMin = lastTs > firstTs ? (lastTs - firstTs) / 60_000 : 0;
  lines.push("");
  lines.push(`model turns:     ${byType.get("request") ?? 0}`);
  lines.push(`snippets:        ${byType.get("snippet") ?? 0} (${records.filter((r) => r.t === "snippet_result" && r["isError"] === true).length} errored)`);
  lines.push(`tool calls:      ${(byType.get("tool_call") ?? 0)}`);
  lines.push(`events served:   ${eventsServed}${spanMin > 0 ? ` (${(eventsServed / spanMin).toFixed(1)}/min)` : ""}`);
  lines.push(`watchdog fires:  ${byType.get("watchdog") ?? 0}`);

  const tail = errors.slice(-5);
  if (tail.length > 0) {
    lines.push("");
    lines.push("last errors / harness notices:");
    for (const e of tail) {
      const text = typeof e["text"] === "string" ? e["text"] : JSON.stringify(e);
      lines.push(`  [${fmtTs(e.ts)}] ${e.t}: ${text.split("\n")[0]!.slice(0, 140)}`);
    }
  }
  if (typeof shakeout === "string" && shakeout.length > 0) {
    lines.push("");
    lines.push(`!! ${shakeout.toUpperCase()} — NOT A SCORED RESULT`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const runId = argv.find((a) => !a.startsWith("--"));
  const dirIdx = argv.indexOf("--runs-dir");
  const runsDir = dirIdx >= 0 ? argv[dirIdx + 1]! : "data/runs";
  if (runId === undefined) {
    console.error("usage: bun runner/src/timeline.ts <run-id> [--runs-dir data/runs]");
    process.exit(2);
  }
  console.log(renderTimeline(join(runsDir, runId), runId));
}
