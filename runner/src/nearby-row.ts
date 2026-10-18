/**
 * Nearby units: what the character's client has in view around it — creatures
 * and other players, where each one is and is going, and the few fields a map
 * colours and names them by — kept for the live map and nothing else.
 *
 * The shapes here are the contract between the sandbox child's recorder
 * (`sandbox/nearby-recorder.ts`), the host's ring writer (`nearby.ts`) and the
 * viewer's codec (`viewer/nearby.ts`): one row per line in the one-minute files
 * of `data/runs/<id>/nearby/`. They are their own contract, apart from the
 * trace's (`trace-row.ts`), because what they feed is live only: the ring holds
 * the last `NEARBY_RING_MS` and is deleted when the process stops (`nearby.ts`
 * says how), it is never written to `run.sqlite`, `trace.jsonl` or
 * `trajectory.jsonl`, and no collector, replay or scorer reads it.
 *
 * Nothing in it is new observation. The recorder reads the SDK's own state
 * cache — the update blocks, splines and query answers the module already
 * served the client — and never the snippet's API, so it sends no packet and
 * the model sees none of it. Names are what the client's own creature and name
 * queries answered, never the wiki bundle.
 */

/** The directory under a run's directory that holds the ring. */
export const NEARBY_DIR = "nearby";
/** One ring file holds this many ms of rows, UTC-aligned, named by its start. */
export const NEARBY_FILE_MS = 60_000;
/** How far back the ring reaches: files that ended longer ago than this are unlinked. */
export const NEARBY_RING_MS = 15 * 60_000;

/** What a unit is, by the guid's high type (0xF130 unit, 0xF140 pet, 0xF150 vehicle) or its create block. */
export type NearbyUnitType = "creature" | "pet" | "vehicle" | "player";

/**
 * What the rows say about one unit besides where it is. Every key is optional
 * on the wire: an absent key is not observed (or not known yet), never zero,
 * and a delta (`st`) carries only the keys that changed, with `null` for one
 * that went back to unobserved.
 */
export interface NearbyState {
  /** `OBJECT_FIELD_ENTRY`, else the entry packed into a unit guid. */
  entry: number | null;
  /** The client's creature-query (units) or name-query (players) answer. */
  name: string | null;
  /** The creature query's subname (`<Weapon Merchant>`). */
  sub: string | null;
  /** The creature query's type (8 is a critter). */
  ctype: number | null;
  level: number | null;
  /** Health as a percentage, 0–100: what a client shows of another unit. */
  hp: number | null;
  /** `UNIT_FIELD_FLAGS`. */
  uf: number | null;
  /** `UNIT_DYNAMIC_FLAGS`: lootable 0x1, tapped 0x4, tapped by the player 0x8, dead 0x20. */
  df: number | null;
  /** `UNIT_NPC_FLAGS`: non-zero is a service NPC. */
  nf: number | null;
  /** The questgiver marker byte the client draws (`DIALOG_STATUS_*`). */
  qg: number | null;
  /** The unit's own target guid. */
  tg: string | null;
  /** Whether that target is this character. */
  tgs: boolean | null;
  /** `UNIT_FIELD_SUMMONEDBY`, else `CREATEDBY`. */
  ow: string | null;
  /** `UNIT_FIELD_CHARMEDBY`. */
  ch: string | null;
  /** `UNIT_FIELD_DISPLAYID`, the scale and the movement flags: kept for a 3D reader, drawn by nothing yet. */
  disp: number | null;
  scale: number | null;
  mf: number | null;
  /** Players: `UNIT_FIELD_BYTES_0`'s race, class and gender. */
  race: number | null;
  cls: number | null;
  gender: number | null;
}

export type NearbyStateKey = keyof NearbyState;

/** The keys, in the order every reader writes them. */
export const NEARBY_STATE_KEYS = [
  "entry",
  "name",
  "sub",
  "ctype",
  "level",
  "hp",
  "uf",
  "df",
  "nf",
  "qg",
  "tg",
  "tgs",
  "ow",
  "ch",
  "disp",
  "scale",
  "mf",
  "race",
  "cls",
  "gender",
] as const satisfies readonly NearbyStateKey[];

/** A point a unit stood at, with its facing when the packet carried one. */
export type NearbyPoint = [x: number, y: number, z: number] | [x: number, y: number, z: number, o: number];

/**
 * Where a unit is, as of `t` (the packet's own time):
 * - `k: "pos"` a position sample — a create or movement block, or a player's
 *   relayed `MSG_MOVE_*` heartbeat; consecutive samples close in time are
 *   walked between;
 * - `k: "mv"` a spline from `p` to `to` over `ms` (`SMSG_MONSTER_MOVE`), or,
 *   with no `to`, a stop held at `p`.
 */
export interface NearbyMotion {
  k: "pos" | "mv";
  t: number;
  p: NearbyPoint;
  to?: [x: number, y: number, z: number];
  ms?: number;
}

/** The character itself, as the rows need it: which map the units are on, and who "self" is. */
export interface NearbySelf {
  guid: string | null;
  map: number | null;
  /** The character's own target guid. */
  target: string | null;
  /** Dead or a released ghost. */
  down: boolean;
}

/** One unit as a `key` or an `in` row states it whole. */
export interface NearbyUnit {
  id: string;
  ty: NearbyUnitType;
  s: Partial<NearbyState>;
  m: NearbyMotion | null;
}

/**
 * One row. `ts` is the child's poll that saw it, so rows are in the order
 * they were seen and a fold over them is causal. A motion also carries the
 * packet's own time (`NearbyMotion.t`, the module's event `ts`, the clock the
 * trace is stamped on), which is what playback evaluates it at.
 *
 * - `key` every unit in view and the self, whole: the child writes one when it
 *   starts and whenever the stream (re)joins the world or the map changes; the
 *   host writes one at the start of every ring file from its own fold.
 * - `in` a unit came into view (or was first positioned).
 * - `mv` a spline, or a stop; `pos` a position sample. Both carry `NearbyMotion`.
 * - `st` the state keys that changed, `nm` a name answer that landed after `in`.
 * - `out` the unit left view.
 * - `self` the self keys that changed.
 * - `tick` the child was polled up to `ts` and nothing else changed: the data's
 *   horizon, so a quiet scene is not read as an old one.
 */
export type NearbyRow =
  | { ts: number; kind: "key"; self: NearbySelf; units: NearbyUnit[] }
  | { ts: number; kind: "in"; u: NearbyUnit }
  | { ts: number; kind: "mv" | "pos"; id: string; m: NearbyMotion }
  | { ts: number; kind: "st"; id: string; s: Partial<NearbyState> }
  | { ts: number; kind: "nm"; id: string; name: string; sub?: string }
  | { ts: number; kind: "out"; id: string }
  | { ts: number; kind: "self"; self: Partial<NearbySelf> }
  | { ts: number; kind: "tick" };

export type NearbyKind = NearbyRow["kind"];

/** What the sandbox child hands the host per drain: the rows, how many the cap dropped, and how far it looked. */
export interface NearbyDrain {
  rows: NearbyRow[];
  dropped: number;
  /** The child's clock at its last poll: every change up to here is in `rows` or an earlier drain. */
  through: number;
}

/** The ring file a timestamp belongs to, as its start. */
export function nearbyFileStart(ts: number): number {
  return Math.floor(ts / NEARBY_FILE_MS) * NEARBY_FILE_MS;
}

/** A self with nothing observed. */
export function emptyNearbySelf(): NearbySelf {
  return { guid: null, map: null, target: null, down: false };
}
