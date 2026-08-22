/**
 * Wiki coordinate extraction.
 *
 * wowwiki records where things stand in a couple of recurring shapes:
 *   {{coords|48.2|42.1|Elwynn Forest}}   - a coords template
 *   | loc = 48.2, 42.1                     - an infobox field, its zone in a
 *   | location = [[Elwynn Forest]]           sibling `location` field
 *
 * These are stripped away by stripWikitext (templates and infobox data are
 * lost), so this runs on the RAW wikitext BEFORE the strip. It is best-effort
 * and deterministic: a malformed or out-of-range template yields nothing rather
 * than a bad row, and the same input always gives the same output.
 *
 * These are wiki-reference coordinates: what an editor wrote on a page, not a
 * live observation and not proof anything is at that spot now. Nothing here
 * reads the server, the AzerothCore DB, DBC tables or Questie.
 */

/** A coordinate as the wiki recorded it. `raw` is the source fragment it came from. */
export interface WikiCoord {
  zone?: string;
  x: number;
  y: number;
  raw: string;
}

/** Map coordinates are percentages of the zone map; anything outside is junk. */
function inRange(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/** `[[a|b]]` -> `b`, drop leftover templates/braces, collapse whitespace. */
function cleanZone(raw: string): string | undefined {
  let s = raw
    .replace(/\[\[([^\]]*)\]\]/g, (_whole, inner: string) => {
      const bar = inner.lastIndexOf("|");
      const hash = inner.indexOf("#");
      const label = bar !== -1 ? inner.slice(bar + 1) : hash !== -1 ? inner.slice(0, hash) : inner;
      return label;
    })
    .replace(/\{\{[^{}]*\}\}/g, " ")
    .replace(/'{2,5}/g, "")
    .replace(/[[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // A trailing wikitext fragment (a stray `=`/`|` param) is not a zone name.
  if (s.includes("=") || s.includes("|")) s = "";
  return s.length > 0 && s.length <= 120 ? s : undefined;
}

/** Bound the array: dedupe identical triples, cap per page. JSON stays finite/safe. */
const MAX_COORDS_PER_PAGE = 8;

function pusher(): { push: (c: WikiCoord) => void; out: WikiCoord[] } {
  const out: WikiCoord[] = [];
  const seen = new Set<string>();
  return {
    out,
    push(c) {
      if (out.length >= MAX_COORDS_PER_PAGE) return;
      if (!inRange(c.x) || !inRange(c.y)) return;
      const key = `${c.x}|${c.y}|${c.zone ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    },
  };
}

// {{coords|...}} / {{coord|...}} / {{Coords| ... }}, no nested braces inside.
const COORDS_TEMPLATE = /\{\{\s*coords?\b([^{}]*)\}\}/gi;
// An infobox `loc`/`coordinates` field: two numbers separated by a comma or slash.
const INFOBOX_LOC =
  /\|\s*(?:loc|location_?coords?|coords?|coordinates)\s*=\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*[,/]\s*([0-9]{1,3}(?:\.[0-9]+)?)/gi;
// An infobox `location`/`zone` field carrying a place name.
const INFOBOX_ZONE = /\|\s*(?:location|zone)\s*=\s*([^\n|}]+)/i;

// A placeholder (private-use codepoint) standing in for pipes INSIDE a `[[...]]`
// link, so splitting the coords template on its param separators does not split
// a piped link in two.
const PIPE_MASK = String.fromCharCode(0xe000);

/**
 * Extract wiki-reference coordinates from raw wikitext. Deterministic, never
 * throws, no network.
 */
export function extractCoords(wikitext: string): WikiCoord[] {
  const { push, out } = pusher();
  if (typeof wikitext !== "string" || wikitext.length === 0) return out;

  // 1. {{coords|X|Y|Zone}} templates.
  for (const m of wikitext.matchAll(COORDS_TEMPLATE)) {
    const masked = (m[1] ?? "").replace(/\[\[[^\]]*\]\]/g, (link) =>
      link.split("|").join(PIPE_MASK),
    );
    const params = masked.split("|").map((p) => p.split(PIPE_MASK).join("|").trim());
    const nums: number[] = [];
    let zone: string | undefined;
    for (const param of params) {
      if (param.length === 0) continue;
      const eq = param.indexOf("=");
      const value = eq === -1 ? param : param.slice(eq + 1).trim();
      const key = eq === -1 ? "" : param.slice(0, eq).trim().toLowerCase();
      const n = Number(value);
      if (value !== "" && Number.isFinite(n) && !/[^0-9.\-+]/.test(value)) {
        if (key === "" || key === "x" || key === "y" || key === "lat" || key === "long" || key === "lon") {
          nums.push(n);
        }
      } else if (zone === undefined) {
        zone = cleanZone(value);
      }
    }
    if (nums.length >= 2) {
      push({ x: nums[0]!, y: nums[1]!, ...(zone !== undefined ? { zone } : {}), raw: m[0] });
    }
  }

  // 2. Infobox loc/coordinates fields, with the page's location field as zone.
  const zoneMatch = INFOBOX_ZONE.exec(wikitext);
  const infoZone = zoneMatch?.[1] !== undefined ? cleanZone(zoneMatch[1]) : undefined;
  for (const m of wikitext.matchAll(INFOBOX_LOC)) {
    push({
      x: Number(m[1]),
      y: Number(m[2]),
      ...(infoZone !== undefined ? { zone: infoZone } : {}),
      raw: m[0].trim(),
    });
  }

  return out;
}
