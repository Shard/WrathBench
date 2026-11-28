/**
 * The dungeon registry: each instance a campaign can target, as data,
 * `runner/dungeons/<id>.json`, one file per instance (docs/EPISODES.md,
 * "Defining a dungeon"). The Deadmines is the template every other entry
 * follows; it carries exactly the facts the Deadmines evals have always run
 * on, so reading them from here moves nothing.
 *
 * A run finds its dungeon from what it already carries: its definition's
 * `start.staged` (the scenario the stager applied) or the instance map its
 * characters entered. Neither the campaign definition nor the episode JSON
 * names a dungeon, so neither schema nor any hash moves for it.
 *
 * Kept free of the runner's heavier modules, like `task-episodes.ts`: the
 * timeline (a viewer-only process), the board, the camera and the tests all
 * import it, and it reaches nothing but zod and the files.
 */

import { z } from "zod";
import deadminesJson from "../dungeons/deadmines.json";
import shadowfangKeepJson from "../dungeons/shadowfang-keep.json";
import stockadeJson from "../dungeons/stockade.json";

const idSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const coord = z.number().finite();

/**
 * The area trigger a party walks into from outside, and the outdoor volume it
 * fires in: a sphere of `radius` yards or an oriented box, as the core's
 * `areatrigger` row has it.
 */
const entranceSchema = z.union([
  z.object({ trigger: z.number().int().positive(), map: z.number().int().min(0), x: coord, y: coord, z: coord, radius: z.number().positive() }).strict(),
  z
    .object({
      trigger: z.number().int().positive(),
      map: z.number().int().min(0),
      x: coord,
      y: coord,
      z: coord,
      box: z.object({ length: z.number().positive(), width: z.number().positive(), height: z.number().positive(), orientation: coord }).strict(),
    })
    .strict(),
]);

/**
 * A boss by creature entry, with its short name. `optional` marks one off the
 * route to the end, which an attempt is never counted by (the Deadmines'
 * Cookie); absent means on the route.
 */
const bossSchema = z
  .object({
    entry: z.number().int().positive(),
    name: z.string().min(1),
    optional: z.literal(true).optional(),
  })
  .strict();

/**
 * One instance. Optional fields carry no default, so nothing here grows a
 * value it was not given. A later `staging` block (the spots, the homebind)
 * belongs beside `staged` once a second instance is staged from here.
 */
export const dungeonSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    kind: z.enum(["dungeon", "raid"]),
    size: z.union([z.literal(5), z.literal(10), z.literal(25), z.literal(40)]),
    /** The instance map. */
    map: z.number().int().min(0),
    entrance: entranceSchema,
    /** The level a reference party is staged at. */
    level: z.number().int().min(1).max(80),
    /** The fixture scenario a campaign's `start.staged` names to start here. */
    staged: idSchema,
    /** In route order, optional bosses wherever they are listed. */
    bosses: z.array(bossSchema).min(1),
    /** The kill that means cleared: a boss on the route. */
    end: z.number().int().positive(),
    /** Provenance: where the ids and coordinates were read. */
    note: z.string().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const entries = d.bosses.map((b) => b.entry);
    if (new Set(entries).size !== entries.length) ctx.addIssue({ code: "custom", path: ["bosses"], message: "a boss entry is listed twice" });
    const end = d.bosses.find((b) => b.entry === d.end);
    if (end === undefined || end.optional === true) ctx.addIssue({ code: "custom", path: ["end"], message: "the end is a boss on the route" });
  });
export type Dungeon = z.infer<typeof dungeonSchema>;
export type DungeonBoss = Dungeon["bosses"][number];

function parse(id: string, raw: unknown): Dungeon {
  const d = dungeonSchema.parse(raw);
  if (d.id !== id) throw new Error(`runner/dungeons/${id}.json names ${d.id}`);
  return d;
}

/** Every instance, the Deadmines first. */
export const DUNGEONS: readonly Dungeon[] = [
  parse("deadmines", deadminesJson),
  parse("shadowfang-keep", shadowfangKeepJson),
  parse("stockade", stockadeJson),
];

/** The instance by id. */
export function dungeonById(id: string): Dungeon | null {
  return DUNGEONS.find((d) => d.id === id) ?? null;
}

/** The instance on a map, or null for a map that is none of them. */
export function dungeonByMap(map: number): Dungeon | null {
  return DUNGEONS.find((d) => d.map === map) ?? null;
}

/** The instance a staged start's scenario is staged for, or null. */
export function dungeonByStaged(scenario: string): Dungeon | null {
  return DUNGEONS.find((d) => d.staged === scenario) ?? null;
}

/** The bosses on the route, in route order: what an attempt is counted by. */
export function routeOf(d: Dungeon): number[] {
  return d.bosses.filter((b) => b.optional !== true).map((b) => b.entry);
}

/** The bosses off the route. */
export function optionalOf(d: Dungeon): number[] {
  return d.bosses.filter((b) => b.optional === true).map((b) => b.entry);
}

/**
 * Every boss of every instance by entry. A creature entry is one creature,
 * so no entry is two instances' (the registry's test holds them disjoint),
 * and a kill's entry alone says it was a boss, wherever it fell.
 */
export const BOSS_ENTRIES: ReadonlySet<number> = new Set(DUNGEONS.flatMap((d) => d.bosses.map((b) => b.entry)));

/** The registry's short name for a boss entry, or null. */
export function bossName(entry: number): string | null {
  for (const d of DUNGEONS) for (const b of d.bosses) if (b.entry === entry) return b.name;
  return null;
}
