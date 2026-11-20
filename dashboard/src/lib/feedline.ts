/**
 * A feed row as one line.
 *
 * An action in an opened run (`lib/feedtier.ts`) is a line, not a card: what
 * it was, what it came to, whether it failed. A milestone is a line too,
 * whichever tier it is on, where it used to be a pretty-printed record. The
 * full row is still one click under either. Pure, like its neighbours.
 */

import type { ActionsEntry, EventsServedEntry, FeedEntry, ResponseEntry } from "@viewer/api-types";
import type { FeedGroup, Lead } from "./feedgroup";
import { FAILED_RECORDS, callName, kindOf, moveRefused, repeatCount, tallyLabel, tallyNotes, tsOf, type FeedKind, type Surface } from "./feedtier";
import { harnessFields, noticeView, splitNotices, stateLine } from "./feedview";
import { fmtDuration, fmtLatency, fmtTokens, fmtUsd, stamp } from "./format";
import { fileChanges } from "./toolargs";

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
 * count of the further occurrences of one since the previous wake. A refusal,
 * fresh or repeated, carries its `action` and `status`; the private viewer
 * also has the signature (`<routine>|<character or seat>|<action>|<status>`
 * for a refusal, `<routine>|<error name>|<file:line>` for an error,
 * `memory|<what>`), which names the routine and the error. A public window
 * carries the words and counts alone, and a record written before a repeat
 * carried its action reads as the count it is, never as a placeholder.
 */
export function programErrorLine(entry: FeedEntry): { label: string; text: string; title?: string | undefined } {
  const e = entry as unknown as Record<string, unknown>;
  const signature = str(e["signature"]);
  const action = str(e["action"]);
  const status = str(e["status"]);
  const refused = action !== undefined && status !== undefined ? `${action} ${status}` : undefined;
  const repeats = repeatCount(entry);
  if (repeats !== null) {
    const more = `×${repeats.toLocaleString("en-US")} more`;
    const since = num(e["since"]);
    const at = num(e["at"]);
    const title = [signature, since !== undefined && at !== undefined ? `${stamp(since)} – ${stamp(at)}` : undefined].filter((p) => p !== undefined).join(" · ");
    const span = title.length > 0 ? title : undefined;
    const parts = (signature ?? "").split("|");
    if (refused !== undefined) {
      // The routine and the character are the signature's leading parts, on the private viewer only.
      const who = parts.length >= 4 ? whose(str(parts.slice(0, -3).join("|")), str(parts[parts.length - 3]!)) : "";
      return { label: "refused", text: `${refused} ${more}${who}`, title: span };
    }
    if (parts.length === 4) {
      const [routine, who, a, st] = parts as [string, string, string, string];
      return { label: "refused", text: `${a} ${st} ${more}${whose(str(routine), str(who))}`, title: span };
    }
    if (parts.length === 2 && parts[0] === "memory") return { label: "program error", text: `memory ${parts[1]} ${more}`, title: span };
    if (parts.length === 3) {
      const [routine, name, place] = parts as [string, string, string];
      return { label: routine.length > 0 ? "routine error" : "program error", text: `${name}${place.length > 0 ? ` at ${place}` : ""} ${more}${whose(str(routine), undefined)}`, title: span };
    }
    return { label: "repeated", text: signature !== undefined ? `${signature} ${more}` : more, title: span };
  }
  // A public window's skeleton: the type and the time, nothing else.
  if (e["kind"] === undefined) return { label: "program error", text: "" };
  const routine = str(e["name"]);
  const who = str(e["seat"]) ?? str(e["character"]);
  if (e["kind"] === "refusal") return { label: "refused", text: `${refused ?? ""}${whose(routine, who)}`.trim(), title: signature };
  // A public window has neither the routine nor the error's text: the label alone says what happened.
  const error = str(e["error"]);
  return { label: routine !== undefined ? "routine error" : "program error", text: `${error !== undefined ? clip(firstLine(error)) : ""}${whose(routine, who)}`.trim(), title: signature };
}

/** A muted figure on a card's head; `err` draws it in the error colour; `title` is its hover. */
export interface Chip {
  text: string;
  title?: string | undefined;
  err?: boolean | undefined;
}

/** How a reply ending reads when it is not the ordinary end of a reply or of its tool calls. */
const ORDINARY_STOPS: ReadonlySet<string> = new Set(["toolUse", "tool_use", "tool_calls", "stop", "end_turn", "endTurn"]);

/**
 * What led to a model output, as chips (`Lead`, `lib/feedgroup.ts`): the
 * model's time before the call, its thinking, its envelope's output tokens,
 * and an envelope's unusual ending or error. Absent fields draw nothing, so a
 * public window, which carries none of the envelope's bookkeeping, shows the
 * think time alone.
 */
export function leadChips(lead: Lead | null): Chip[] {
  if (lead === null) return [];
  const out: Chip[] = [];
  if (lead.thinkMs !== null) out.push({ text: `think ${fmtLatency(lead.thinkMs)}`, title: "the model's time before this call: from what last fed it to the call" });
  if (lead.thinkingTokens !== null && lead.thinkingTokens > 0) out.push({ text: `~${fmtTokens(lead.thinkingTokens)} thinking`, title: "thinking tokens, as the CLI estimated them" });
  const env = lead.envelope;
  if (env !== null) {
    if (typeof env.thinkingChars === "number" && env.thinkingChars > 0) out.push({ text: `${fmtTokens(env.thinkingChars)} chars thinking` });
    const completion = env.usage?.completion;
    if (typeof completion === "number" && completion > 0) out.push({ text: `${fmtTokens(completion)} out`, title: "output tokens of the reply this call came in" });
    if (typeof env.stopReason === "string" && !ORDINARY_STOPS.has(env.stopReason)) out.push({ text: `stop ${env.stopReason}`, err: true });
    if (typeof env.error === "string" && env.error.length > 0) out.push({ text: "error", title: env.error, err: true });
  }
  return out;
}

/** What a call's deploys say that its result does not: a failed one, with its error on the hover. */
export function deployChips(deploys: readonly FeedEntry[]): Chip[] {
  const out: Chip[] = [];
  for (const d of deploys) {
    const e = d as unknown as Record<string, unknown>;
    if (e["ok"] === false) out.push({ text: "deploy failed", title: str(e["error"]), err: true });
  }
  return out;
}

/** A tool name as recorded on a reply, less the CLI's prefix for the run's own tools. */
export function toolLabel(name: string): string {
  return name.replace(/^mcp__wrathbench__|^wrathbench\./, "");
}

/** A pi summarisation call in figures: tokens in and out, and pi's price for it. */
export function compactionLine(e: ResponseEntry): string {
  const parts: string[] = [];
  if (e.usage !== undefined) parts.push(`${fmtTokens(e.usage.prompt)} in · ${fmtTokens(e.usage.completion)} out`);
  if (typeof e.piCostUsd === "number") parts.push(fmtUsd(e.piCostUsd));
  return parts.join(" · ");
}

/** A reply that is not a row of words: a compaction call, an envelope no card claimed, an empty or errored reply. */
export function replyLine(e: ResponseEntry): { label: string; text: string; failed: boolean } {
  if (e.kind === "compaction") return { label: "compaction call", text: compactionLine(e), failed: false };
  const tools = (e.tools ?? []).map(toolLabel);
  const stop = typeof e.stopReason === "string" && !ORDINARY_STOPS.has(e.stopReason) ? e.stopReason : undefined;
  const failed = stop === "error" || (typeof e.error === "string" && e.error.length > 0);
  const parts = [tools.join(", "), stop !== undefined ? `stop ${stop}` : "", typeof e.error === "string" ? firstLine(e.error) : ""].filter((s) => s.length > 0);
  if (parts.length === 0 && e.usage !== undefined) parts.push(`${fmtTokens(e.usage.completion)} out`);
  return { label: tools.length > 0 ? "call" : "response", text: clip(parts.join(" · ")), failed };
}

/** A `claude_system` record in words: the CLI's own bookkeeping, never its raw type and subtype. */
export function claudeSystemLine(entry: FeedEntry): string {
  const e = entry as unknown as Record<string, unknown>;
  const subtype = str(e["subtype"]) ?? "system";
  switch (subtype) {
    case "init": {
      const model = str(e["model"]);
      const version = str(e["claude_code_version"]);
      return ["session start", model, version !== undefined ? `cli ${version}` : undefined].filter((s) => s !== undefined).join(" · ");
    }
    case "compact_boundary": {
      const m = (e["compact_metadata"] ?? {}) as Record<string, unknown>;
      const pre = num(m["pre_tokens"]);
      const post = num(m["post_tokens"]);
      return ["compaction", str(m["trigger"]), pre !== undefined ? `${fmtTokens(pre)}${post !== undefined ? ` → ${fmtTokens(post)}` : ""} tokens` : undefined].filter((s) => s !== undefined).join(" · ");
    }
    case "thinking_tokens": {
      const n = num(e["estimated_tokens"]);
      return n !== undefined ? `thinking ~${fmtTokens(n)} tokens` : "thinking";
    }
    default: {
      const rest = fieldsLine(entry, ["type", "subtype", "session_id", "uuid"]);
      const words = subtype.replaceAll("_", " ");
      return clip(rest.length > 0 ? `${words} · ${rest}` : words);
    }
  }
}

/**
 * A `termination` or `watchdog` record as one line: its reason, then its
 * detail with the spans the writers give in milliseconds as durations
 * (`idle — no tool call for 20m49s: 5 wakes in a row answered without one`).
 * A public watchdog carries its reason alone.
 */
export function endLine(entry: FeedEntry): string {
  const e = entry as unknown as Record<string, unknown>;
  const reason = str(e["reason"]) ?? entry.t;
  const detail = str(e["detail"])?.replace(/\b(\d+)ms\b/g, (_, n: string) => fmtLatency(Number(n)));
  return detail !== undefined ? `${reason} — ${detail}` : reason;
}

/** A `deploy` record no write claimed, in words. */
export function deployLine(entry: FeedEntry): { text: string; failed: boolean } {
  const e = entry as unknown as Record<string, unknown>;
  if (e["ok"] === false) return { text: clip(`failed${str(e["error"]) !== undefined ? ` · ${firstLine(str(e["error"])!)}` : ""}`), failed: true };
  const routines = Array.isArray(e["routines"]) ? (e["routines"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const n = num(e["deploy"]);
  return { text: clip([n !== undefined ? `${n}` : "", routines.length > 0 ? `routines ${routines.join(", ")}` : ""].filter((s) => s.length > 0).join(" · ")), failed: false };
}

/** One row as one line. */
export function lineOf(g: FeedGroup, surface: Surface = {}): LineView {
  const kind = kindOf(g, surface);
  const ts = tsOf(g);
  switch (g.kind) {
    case "turn":
      return { kind, label: `turn ${g.request.turn ?? "?"}`, text: "", failed: false, ts, turn: g.request.turn };
    case "response": {
      if ((g.entry.text ?? "").trim().length > 0) return { kind, label: "response", text: clip(g.entry.text!), failed: false, ts, turn: g.entry.turn };
      const r = replyLine(g.entry);
      return { kind, label: r.label, text: r.text, failed: r.failed, ts, turn: g.entry.turn };
    }
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
        case "claude_system":
          return { ...base, label: "claude", text: claudeSystemLine(entry) };
        case "termination":
        case "watchdog":
          return { ...base, label: entry.t, text: clip(endLine(entry)) };
        case "codex_tool_call": {
          // Code mode's script, by its first line; a public window has the name and the time.
          const input = str(e["input"]);
          const status = str(e["status"]);
          return { ...base, label: str(e["name"]) ?? "codex tool", text: input !== undefined ? clip(firstLine(input)) : "", failed: status !== undefined && status !== "completed" };
        }
        case "codex_item": {
          const changes = fileChanges(e["body"]);
          if (changes === null) return { ...base, label: entry.t, text: clip(fieldsLine(entry, [])) };
          return { ...base, label: "file change", text: clip(changes.map((c) => `${c.kind} ${c.path}`).join(", ")) };
        }
        case "deploy": {
          const d = deployLine(entry);
          return { ...base, label: "deploy", text: d.text, failed: d.failed };
        }
        default:
          return { ...base, label: entry.t, text: clip(fieldsLine(entry, [])), failed: FAILED_RECORDS.has(entry.t) };
      }
    }
  }
}
