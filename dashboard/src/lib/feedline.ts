/**
 * A feed row as one line.
 *
 * An action in an opened run (`lib/feedtier.ts`) is a line, not a card: what
 * it was, what it came to, whether it failed. A milestone is a line too,
 * whichever tier it is on, where it used to be a pretty-printed record. The
 * full row is still one click under either. Pure, like its neighbours.
 */

import type { ActionsEntry, EventsServedEntry, FeedEntry } from "@viewer/api-types";
import type { FeedGroup } from "./feedgroup";
import { FAILED_RECORDS, callName, kindOf, moveRefused, repeatCount, tallyLabel, tallyNotes, tsOf, type FeedKind, type Surface } from "./feedtier";
import { harnessFields, noticeView, splitNotices, stateLine } from "./feedview";
import { fmtDuration, stamp } from "./format";

export interface LineView {
  kind: FeedKind;
  /** What the row is called: the tool, the record type. */
  label: string;
  text: string;
  failed: boolean;
  ts: number;
  turn: number | undefined;
  /** What the line leaves out that a reader may hover for. */
  title?: string | undefined;
}

const LINE_MAX = 160;

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1)}…` : one;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A zone, an area or a level as a record names it: `{ id, name? }`, or the bare value. */
function place(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  return str(o["name"]) ?? (num(o["id"]) ?? num(o["areaId"]))?.toString();
}

function fromTo(e: Record<string, unknown>): string {
  const from = place(e["from"]);
  const to = place(e["to"]);
  if (from !== undefined && to !== undefined) return `${from} → ${to}`;
  return to ?? from ?? "";
}

/** The one-line summary of an events batch, shared by the rows and the turn headers. */
export function eventsHead(e: EventsServedEntry): string {
  const more = (e.moreOpcodes ?? 0) > 0 ? ` +${e.moreOpcodes} kinds` : "";
  return `${e.count ?? 0} events · ${(e.opcodes ?? []).join(" ")}${more}`.trim();
}

/** A record's fields on one line, less the ones named. */
function fieldsLine(entry: FeedEntry, skip: readonly string[]): string {
  const drop = new Set(["i", "t", "ts", "start", "end", "clipped", "turn", "observedTs", ...skip]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(entry as unknown as Record<string, unknown>)) {
    if (drop.has(k) || v === null || v === undefined) continue;
    parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(" · ");
}

/**
 * A `milestone` or `quest_complete` record in words. Ids stay ids where the
 * record has no name for them; a kind this build does not know reads as its
 * name and its fields.
 */
export function milestoneLine(entry: FeedEntry): string {
  const e = entry as unknown as Record<string, unknown>;
  if (entry.t === "quest_complete") return `turned in quest ${num(e["questId"]) ?? "?"}`;
  const kind = str(e["kind"]) ?? entry.t;
  switch (kind) {
    case "level":
      return `level ${fromTo(e)}`;
    case "death": {
      const zone = place(e["zone"]);
      return zone === undefined ? "died" : `died in zone ${zone}`;
    }
    case "zone":
    case "area":
      return `${kind} ${fromTo(e)}`;
    case "taxi":
      return "took a flight";
    case "taxi_landed":
      return "landed";
    case "release":
      return "released its spirit";
    case "resurrect":
      return "resurrected";
    case "achievement": {
      const points = num(e["points"]);
      return `achievement ${str(e["name"]) ?? num(e["id"]) ?? "?"}${points !== undefined ? ` · ${points} points` : ""}`;
    }
    case "spell":
      return `learned spell ${num(e["id"]) ?? "?"}`;
    case "talent":
      return `talent ${num(e["id"]) ?? "?"} rank ${num(e["rank"]) ?? "?"}`;
    case "trade":
      return "traded";
    default: {
      const rest = fieldsLine(entry, ["kind"]);
      return clip(rest.length > 0 ? `${kind.replaceAll("_", " ")} · ${rest}` : kind.replaceAll("_", " "));
    }
  }
}

function moveLine(e: Record<string, unknown>): string {
  const at = `(${num(e["x"])?.toFixed(0) ?? "?"}, ${num(e["y"])?.toFixed(0) ?? "?"})`;
  const target = str(e["target"]);
  const status = str(e["status"]);
  return `to ${target !== undefined ? `${target} ` : ""}${at}${status !== undefined ? ` → ${status.replaceAll("_", " ")}` : " · dispatched"}`;
}

function firstLine(text: string): string {
  const at = text.indexOf("\n");
  return at === -1 ? text : text.slice(0, at);
}

/** " (routine grind, Tankpartyb)", or as much of it as there is. */
function whose(routine: string | undefined, who: string | undefined): string {
  const parts = [routine !== undefined ? `routine ${routine}` : undefined, who].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * A `program_error` record in words: a fresh refusal or error, or a wake's
 * count of the further occurrences of one since the previous wake. A repeat
 * names its error or refusal by its signature alone, so the line is read off
 * that (`<routine>|<character or seat>|<action>|<status>` for a refusal,
 * `<routine>|<error name>|<file:line>` for an error, `memory|<what>`), and
 * a signature of any other shape is shown as it is.
 */
export function programErrorLine(entry: FeedEntry): { label: string; text: string; title?: string | undefined } {
  const e = entry as unknown as Record<string, unknown>;
  const signature = str(e["signature"]);
  const repeats = repeatCount(entry);
  if (repeats !== null) {
    const more = `×${repeats.toLocaleString("en-US")} more`;
    const since = num(e["since"]);
    const at = num(e["at"]);
    const title = [signature, since !== undefined && at !== undefined ? `${stamp(since)} – ${stamp(at)}` : undefined].filter((p) => p !== undefined).join(" · ");
    const span = title.length > 0 ? title : undefined;
    const parts = (signature ?? "").split("|");
    if (parts.length === 4) {
      const [routine, who, action, status] = parts as [string, string, string, string];
      return { label: "refused", text: `${action} ${status} ${more}${whose(str(routine), str(who))}`, title: span };
    }
    if (parts.length === 2 && parts[0] === "memory") return { label: "program error", text: `memory ${parts[1]} ${more}`, title: span };
    if (parts.length === 3) {
      const [routine, name, place] = parts as [string, string, string];
      return { label: routine.length > 0 ? "routine error" : "program error", text: `${name}${place.length > 0 ? ` at ${place}` : ""} ${more}${whose(str(routine), undefined)}`, title: span };
    }
    return { label: "repeated", text: `${signature ?? "?"} ${more}`, title: span };
  }
  // A public window's skeleton: the type and the time, nothing else.
  if (e["kind"] === undefined) return { label: "program error", text: "" };
  const routine = str(e["name"]);
  const who = str(e["seat"]) ?? str(e["character"]);
  if (e["kind"] === "refusal") {
    return { label: "refused", text: `${str(e["action"]) ?? "?"} ${str(e["status"]) ?? "?"}${whose(routine, who)}`, title: signature };
  }
  const error = str(e["error"]);
  return { label: routine !== undefined ? "routine error" : "program error", text: `${clip(firstLine(error ?? "?"))}${whose(routine, who)}`, title: signature };
}

/** One row as one line. */
export function lineOf(g: FeedGroup, surface: Surface = {}): LineView {
  const kind = kindOf(g, surface);
  const ts = tsOf(g);
  switch (g.kind) {
    case "turn":
      return { kind, label: `turn ${g.request.turn ?? "?"}`, text: "", failed: false, ts, turn: g.request.turn };
    case "response":
      return { kind, label: "response", text: clip((g.entry.text ?? "").length > 0 ? g.entry.text! : (g.entry.tools ?? []).join(", ")), failed: false, ts, turn: g.entry.turn };
    case "call": {
      const r = g.result;
      const text = r === null ? "no result yet" : firstLine(splitNotices(r.text ?? "").body);
      return { kind, label: callName(g) ?? "?", text: clip(text), failed: r?.isError === true, ts, turn: (g.call ?? g.snippet ?? g.result)?.turn };
    }
    default: {
      const entry = g.entry;
      const e = entry as unknown as Record<string, unknown>;
      const base = { kind, ts, turn: entry.turn, failed: false };
      switch (entry.t) {
        case "move":
          return { ...base, label: e["routine"] === true ? "routine move" : "move", text: moveLine(e), failed: moveRefused(e["status"]) };
        case "state":
          return { ...base, label: "state", text: stateLine(entry) };
        case "events_served":
          return { ...base, label: "events", text: eventsHead(entry as EventsServedEntry) };
        case "actions": {
          const tally = tallyNotes([entry as ActionsEntry]);
          return { ...base, label: e["routine"] === true ? "routine" : "actions", text: tallyLabel(tally), failed: tally.failed > 0 };
        }
        case "milestone":
        case "quest_complete":
          // The line is the whole of it; the icon says which kind.
          return { ...base, label: milestoneLine(entry), text: "" };
        case "harness":
        case "notice": {
          const n = noticeView(entry);
          return { ...base, label: "harness", text: clip(n.bookkeeping ? [n.kind, harnessFields(entry)].filter((s) => s.length > 0).join(" · ") : `${n.kind} · ${n.text}`) };
        }
        case "program_error": {
          const p = programErrorLine(entry);
          return { ...base, label: p.label, text: clip(p.text), failed: repeatCount(entry) === null && e["kind"] !== undefined, title: p.title };
        }
        case "wake": {
          const reasons = Array.isArray(e["reasons"]) ? (e["reasons"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
          const slept = num(e["sleptMs"]);
          return { ...base, label: "wake", text: [slept !== undefined ? `slept ${fmtDuration(slept)}` : "", reasons.join(", ")].filter((s) => s.length > 0).join(" · ") };
        }
        default:
          return { ...base, label: entry.t, text: clip(fieldsLine(entry, [])), failed: FAILED_RECORDS.has(entry.t) };
      }
    }
  }
}
