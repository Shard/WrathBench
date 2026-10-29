/**
 * An `InspectStore` over the collector's own rows, held in memory: what the
 * inspect tests read in place of ClickHouse, so they stay green from a bare
 * clone with no server.
 *
 * The rows are the collector's: its ingestion runs over the fixture's run
 * directories into a memory sink, so they are the rows ClickHouse would hold,
 * the token strike, the line numbering and the table split included. What this
 * file adds is each query's meaning in plain code, the same meaning
 * `rowsSql` and `extentSql` (infra/inspect-run.ts) give ClickHouse; the SQL
 * text itself is checked against a live server, not here.
 */

import { Collector } from "../collector/src/collector";
import { readConfig } from "../collector/src/config";
import { OffsetStore } from "../collector/src/offsets";
import { memorySink } from "../collector/src/sink";
import {
  type ExtentRow,
  extentOf,
  type InspectStore,
  PAD_HEADER_RAW,
  PAD_REFUSED,
  RAW_CAP_BYTES,
  type ReadSpec,
  type Rule,
  runRowOf,
  SIZE_ONLY,
  type StateRow,
  type StoreRow,
  type StoreRun,
  TURN_KINDS,
  UNPARSEABLE,
  type Window,
} from "./inspect-run";

type Row = Record<string, unknown>;

/** A line as the two trajectory tables hold it, whichever it is in. */
interface Line {
  run_id: string;
  line_no: number;
  ts: number;
  kind: string;
  raw: string;
  tool_name: string;
  is_error: number | null;
  turns: boolean;
}

/** The newest row per key, as a merged ReplacingMergeTree reads. */
function merged(rows: readonly Row[], key: (r: Row) => string): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) out.set(key(r), r);
  return [...out.values()];
}

function inWindow(ts: number, w: Window): boolean {
  return (w.since === null || ts >= Math.ceil(w.since)) && (w.until === null || ts <= Math.floor(w.until));
}

function holds(rule: Rule, l: Line): boolean {
  if (rule === "all") return true;
  if (rule === "none") return false;
  return (
    (rule.contains !== undefined && l.raw.includes(rule.contains)) ||
    (rule.error === true && l.turns && l.is_error === 1) ||
    (rule.names !== undefined && l.turns && rule.names.includes(l.tool_name))
  );
}

/** `substringUTF8(s, from, n)`: by code point, 1-based. */
function codePoints(s: string, from: number, n: number): string {
  return Array.from(s)
    .slice(from - 1, from - 1 + n)
    .join("");
}

export interface MemoryStore extends InspectStore {
  /** Every `rows` page asked for: [from, to). */
  pages: [number, number][];
  /** Every line `raws` was asked for whole. */
  wholeLines: number[];
}

/** The store, filled by one collector pass over `runsDir`. */
export async function memoryStore(runsDir: string): Promise<MemoryStore> {
  const sink = memorySink();
  await new Collector({ cfg: readConfig({ runsDir, stateDb: ":memory:" }), sink, offsets: new OffsetStore(":memory:"), log: () => {} }).pass();
  const table = (name: string): Row[] => (sink.tables.get(name) ?? []) as Row[];
  const lines: Line[] = [];
  for (const turns of [true, false]) {
    for (const r of merged(table(turns ? "turns" : "events"), (r) => `${String(r["run_id"])}\u0000${String(r["line_no"])}`)) {
      lines.push({
        run_id: String(r["run_id"]),
        line_no: r["line_no"] as number,
        ts: r["ts"] as number,
        kind: String(r["kind"]),
        raw: String(r["raw"]),
        tool_name: turns ? String(r["tool_name"] ?? "") : "",
        is_error: turns ? ((r["is_error"] as number | null) ?? null) : null,
        turns,
      });
    }
  }
  lines.sort((a, b) => a.line_no - b.line_no);
  const runs = merged(table("runs"), (r) => String(r["run_id"]));
  const states = merged(table("states"), (r) => `${String(r["run_id"])}\u0000${String(r["ts"])}\u0000${String(r["seq"])}`);
  const of = (id: string): Line[] => lines.filter((l) => l.run_id === id);
  const pages: [number, number][] = [];
  const wholeLines: number[] = [];

  return {
    pages,
    wholeLines,
    async runs(ids) {
      const out = new Map<string, StoreRun>();
      for (const r of runs) if (ids.includes(String(r["run_id"]))) out.set(String(r["run_id"]), { ...runRowOf(r), archived: r["archived"] === 1 });
      return out;
    },
    async latestStates(ids) {
      const out = new Map<string, StateRow>();
      for (const id of ids) {
        const mine = states.filter((s) => s["run_id"] === id).sort((a, b) => (b["seq"] as number) - (a["seq"] as number));
        const s = mine[0];
        if (s === undefined) continue;
        const pick = (k: string): number | null => (typeof s[k] === "number" ? (s[k] as number) : null);
        out.set(id, {
          ts: s["ts"] as number,
          level: pick("level"),
          xp: pick("xp"),
          money: pick("money"),
          quests_completed: pick("quests_completed"),
          turn: pick("turn"),
          zone: pick("zone"),
          next_level_xp: pick("next_level_xp"),
        });
      }
      return out;
    },
    async quests(id) {
      return states
        .filter((s) => s["run_id"] === id && typeof s["quests_completed"] === "number")
        .sort((a, b) => (a["ts"] as number) - (b["ts"] as number) || (a["seq"] as number) - (b["seq"] as number))
        .map((s) => ({ ts: s["ts"] as number, quests: s["quests_completed"] as number }));
    },
    async extent(id, w) {
      const byKind = new Map<string, Line[]>();
      for (const l of of(id)) byKind.set(l.kind, [...(byKind.get(l.kind) ?? []), l]);
      const rows: ExtentRow[] = [];
      for (const [k, ls] of byKind) {
        const inW = ls.filter((l) => inWindow(l.ts, w));
        const recs = k === UNPARSEABLE ? [] : inW;
        const newest = recs.reduce<Line | null>((m, l) => (m === null || l.ts > m.ts || (l.ts === m.ts && l.line_no > m.line_no) ? l : m), null);
        rows.push({
          k,
          n: inW.length,
          lo: inW[0]?.line_no ?? 0,
          hi: inW[inW.length - 1]?.line_no ?? 0,
          np: recs.length,
          first_ts: recs[0]?.ts ?? 0,
          first_l: recs[0]?.line_no ?? 0,
          last_ts: recs[recs.length - 1]?.ts ?? 0,
          last_l: recs[recs.length - 1]?.line_no ?? 0,
          newest_ts: newest?.ts ?? 0,
          newest_l: newest?.line_no ?? 0,
          all_ts: k === UNPARSEABLE ? 0 : Math.max(...ls.map((l) => l.ts)),
          all_n: k === UNPARSEABLE ? 0 : ls.length,
        });
      }
      return extentOf(rows);
    },
    async rows(id, spec: ReadSpec, w, from, to) {
      pages.push([from, to]);
      const out: StoreRow[] = [];
      for (const l of of(id)) {
        if (l.line_no < from || l.line_no >= to || !inWindow(l.ts, w)) continue;
        const want = spec.kinds === "all" ? { raw: "all" as Rule } : spec.kinds[l.kind];
        if (want === undefined || TURN_KINDS.includes(l.kind) !== l.turns) continue;
        if (!holds(want.row ?? "all", l)) continue;
        const bytes = Buffer.byteLength(l.raw);
        const request = l.turns && l.kind === "request";
        const at = l.raw.lastIndexOf(PAD_HEADER_RAW);
        const refusal = l.raw.indexOf(PAD_REFUSED);
        const refusalAt = Array.from(l.raw.slice(0, Math.max(0, refusal))).length + 1;
        out.push({
          l: l.line_no,
          ts: l.ts,
          k: l.kind,
          b: bytes,
          n: l.tool_name,
          e: l.is_error,
          r: SIZE_ONLY.has(l.kind) || bytes > RAW_CAP_BYTES || !holds(want.raw, l) ? "" : l.raw,
          h: spec.heads === true && request ? codePoints(l.raw, 1, 400) : "",
          p: spec.pads === true && request && at >= 0 ? l.raw.slice(at) : "",
          q:
            spec.refusals === true && l.turns && (l.kind === "snippet_result" || l.kind === "tool_result") && refusal >= 0
              ? codePoints(l.raw, Math.max(1, refusalAt - 48), 48 + PAD_REFUSED.length + 24)
              : "",
        });
      }
      return out;
    },
    async raws(id, wanted) {
      wholeLines.push(...wanted);
      const out = new Map<number, string>();
      for (const l of of(id)) if (l.turns && wanted.includes(l.line_no)) out.set(l.line_no, l.raw);
      return out;
    },
  };
}
