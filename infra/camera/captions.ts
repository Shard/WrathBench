/**
 * Captions: the model's own words at a moment (docs/ARCHITECTURE.md,
 * "Camera"). A caption is the nearest preceding model text or scratchpad line
 * in the run's trajectory, trimmed to about 120 characters; the pages show it
 * under the video beside the model's display name. Only text the model wrote is
 * read: a `response`'s content and what it wrote to its pad. Tool results,
 * snippet output and events are never read, so no quest, gossip, item or mail
 * text can reach a caption from the game's side.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelOf } from "../model-catalogue";

export const BENCHMARK_NAME = "WrathBench";
export const CAPTION_CHARS = 120;

export interface Said {
  ts: number;
  text: string;
}

const PAD_TOOL = /(?:^|__|\.)(write|edit)_scratchpad$/;

/** One line of plain text: whitespace folded, markdown markers dropped, cut at `max` on a word. */
function captionLine(text: string, max: number = CAPTION_CHARS): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[#>*\-\s]+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join(" ");
  }
  return "";
}

/** The first line of a pad write that says something. */
function padLine(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const text = typeof a["content"] === "string" ? a["content"] : typeof a["new"] === "string" ? a["new"] : typeof a["new_string"] === "string" ? a["new_string"] : "";
  for (const line of text.split("\n")) {
    const l = captionLine(line);
    if (l.length >= 8) return l;
  }
  return "";
}

/** What the model said over a trajectory's text, in time order. */
export function saidOf(trajectoryText: string): Said[] {
  const out: Said[] = [];
  for (const line of trajectoryText.split("\n")) {
    if (line.trim() === "") continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = r["ts"];
    if (typeof ts !== "number") continue;
    let text = "";
    if (r["t"] === "response") {
      const msg = r["message"];
      text = msg !== null && typeof msg === "object" ? captionLine(contentText((msg as Record<string, unknown>)["content"])) : "";
    } else if (r["t"] === "tool_call" && typeof r["name"] === "string" && PAD_TOOL.test(r["name"])) {
      text = padLine(r["args"]);
    }
    if (text !== "") out.push({ ts, text });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** The nearest preceding line at `ts`, or "". */
export function saidAt(said: readonly Said[], ts: number): string {
  let lo = 0;
  let hi = said.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (said[mid]!.ts <= ts) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? "" : said[found]!.text;
}

/** The model's display name: the catalogue's, else the id as the run names it. */
export function modelNameOf(model: string | null | undefined): string {
  return modelOf(model).name ?? model ?? "a model";
}

/** The run's model id and what it said, from its directory. */
export function readRunWords(runDir: string): { model: string | null; said: Said[] } {
  let model: string | null = null;
  try {
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as { config?: { model?: unknown } };
    model = typeof meta.config?.model === "string" ? meta.config.model : null;
  } catch {
    /* no meta: an unnamed model */
  }
  let said: Said[] = [];
  try {
    said = saidOf(readFileSync(join(runDir, "trajectory.jsonl"), "utf8"));
  } catch {
    /* no trajectory */
  }
  return { model, said };
}
