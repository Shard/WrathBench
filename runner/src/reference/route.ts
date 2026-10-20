/**
 * The scripted reference run's route: a speedrunner's notes, as data.
 *
 * What is here is what a player who has run this content before carries in
 * their head — which NPC (by creature entry) stands roughly where, which quest
 * ids to take from whom and in what order, which creatures to hunt for what,
 * and where. Nothing here is read from the server: the positions were taken
 * from what models' own clients observed in Northshire (`state.units()` rows in
 * their trajectories), and the program (`program.ts`) still finds every NPC and
 * every mob by looking at what is in view. A position only has to be close
 * enough for the thing to come into view; a quest id that is not offered is
 * skipped and noted, never forced.
 *
 * Deliberately no game text: entries, quest ids and coordinates only. Where a
 * collect objective's source is a world object, the program matches it by the
 * name the quest log itself shows at run time (`QuestObjective.text`), so no
 * item or object name is written down here.
 *
 * A route is versioned: its id and version are the run's `model`
 * (`referenceModelId`), so two runs of different routes never read as one line.
 * Extending the arc is adding steps before the final `grind`, and a version
 * bump; so is a change to how the program plays a step (`program.ts`), since
 * the line is the route as played, not the data alone.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * One step of the route. The program plays a step a tick at a time (a tick is
 * one snippet, well inside the snippet timeout) and reports when it is done;
 * every step is idempotent against the world, so a step replayed after a
 * restart finds its work already done and moves on.
 */
export type RouteStep =
  /** Walk to an NPC; turn in whichever of `turnIn` the log holds complete, then take whichever of `accept` it offers. */
  | {
      readonly kind: "visit";
      readonly npc: number;
      readonly at: Point;
      readonly turnIn?: readonly number[];
      readonly accept?: readonly number[];
      /** Reward index per quest id when the window offers a choice; 0 otherwise. */
      readonly reward?: Readonly<Record<number, number>>;
    }
  /**
   * Work the listed quests' open objectives: kill objectives by their own
   * creature entry, collect objectives from `drops` (creatures whose loot holds
   * the item) or from a world object whose name the objective text carries.
   * Done when none of the quests is in the log with an objective open.
   */
  | {
      readonly kind: "objectives";
      readonly quests: readonly number[];
      readonly drops?: readonly number[];
      readonly areas: readonly Point[];
    }
  /** Learn every spell the class trainer will teach now and the purse covers. */
  | { readonly kind: "train"; readonly npc: number; readonly at: Point }
  /** Sell the poor-quality items in the bags. */
  | { readonly kind: "vendor"; readonly npc: number; readonly at: Point }
  /** Walk a chain of waypoints. */
  | { readonly kind: "travel"; readonly via: readonly Point[] }
  /** Hunt `targets` around `areas` until the clock runs out. The last step; never done. */
  | { readonly kind: "grind"; readonly targets: readonly number[]; readonly areas: readonly Point[] };

/** A gate on a step: skipped below this level. */
export type GatedStep = RouteStep & { readonly minLevel?: number; readonly maxMinutes?: number };

export interface Route {
  readonly id: string;
  readonly version: number;
  /** The start this route is written for; the launch refuses any other. */
  readonly race: number;
  readonly class: number;
  readonly steps: readonly GatedStep[];
  /**
   * Self-buffs, each a rank family lowest first: the highest rank the
   * spellbook holds is cast whenever none of the family is on the character.
   */
  readonly buffs: readonly (readonly number[])[];
  /** The self-heal rank family, lowest first. */
  readonly heal: readonly number[];
  /** Vendors the program may divert to when the bags are full. */
  readonly vendors: readonly { readonly npc: number; readonly at: Point }[];
}

// ------------------------------------------------------------ Northshire

const P = (x: number, y: number, z: number): Point => ({ x, y, z });

/** Creature entries, Northshire Valley and Goldshire. */
const NPC = {
  willem: 823,
  mcbride: 197,
  eagan: 196,
  milly: 9296,
  neals: 952,
  sammuel: 925,
  janos: 78,
  dughan: 240,
  remy: 241,
  pestle: 253,
  farley: 295,
  wilhelm: 927,
  argus: 514,
} as const;

const MOB = {
  koboldVermin: 6,
  koboldWorker: 257,
  koboldLaborer: 80,
  youngWolf: 299,
  timberWolf: 69,
  defiasThug: 38,
  garrick: 103,
  // Elwynn, around Goldshire and the mines south of it.
  koboldTunneler: 475,
  koboldMiner: 40,
  defiasBandit: 116,
  forestSpider: 30,
  youngForestBear: 822,
  mangyWolf: 525,
  prowler: 118,
} as const;

/** Where each NPC was observed standing. */
const AT = {
  willem: P(-8948, -132, 84),
  mcbride: P(-8903, -163, 82),
  eagan: P(-8869, -163, 81),
  milly: P(-8850, -224, 82),
  neals: P(-8902, -182, 113),
  sammuel: P(-8915, -215, 82),
  janos: P(-8909, -104, 82),
  /** Goldshire's crossroads: every NPC of the hamlet is in view from here. */
  goldshire: P(-9460, 60, 57),
} as const;

/** Hunting grounds, from where the mobs were observed. */
const GROUND = {
  vineyardEast: [P(-8790, -160, 83), P(-8770, -200, 82), P(-8805, -240, 82), P(-8760, -125, 86)],
  wolves: [P(-8830, -110, 83), P(-8860, -95, 84), P(-8807, -180, 90), P(-8780, -100, 88)],
  koboldCamp: [P(-8800, -240, 82), P(-8770, -250, 82), P(-8767, -159, 85), P(-8720, -150, 88)],
  echoRidge: [P(-8660, -130, 88), P(-8638, -128, 88), P(-8610, -110, 80), P(-8595, -90, 72)],
  vineyardSouth: [P(-8995, -361, 84), P(-9043, -332, 84), P(-8960, -395, 84), P(-9060, -300, 84)],
  elwynn: [P(-9390, -20, 62), P(-9560, -40, 58), P(-9620, 110, 48), P(-9790, 140, 30), P(-9480, 180, 56)],
} as const;

/** Northshire's exit road to Goldshire. */
const TO_GOLDSHIRE = [P(-9000, -90, 82), P(-9150, -20, 72), P(-9300, 30, 64), AT.goldshire];

/**
 * Human Paladin, Northshire Valley to Goldshire, then hunting Elwynn.
 *
 * The order is the usual one: the intro, the vermin and the wolves together,
 * the class letter and the trainer, the workers, the thieves and the harvest
 * together in the south vineyard, the laborers and the bounty, and down the
 * road to Goldshire. Quest ids are the ones models' runs completed here.
 */
export const NORTHSHIRE_PALADIN: Route = {
  id: "elwynn-human-paladin",
  version: 2,
  race: 1,
  class: 2,
  buffs: [
    // Seal of Righteousness, Devotion Aura, Blessing of Might: lowest rank first.
    [21084, 20154],
    [465, 10290, 643],
    [19740, 19834],
  ],
  // Holy Light ranks 1-3.
  heal: [635, 639, 647],
  vendors: [{ npc: NPC.janos, at: AT.janos }],
  steps: [
    { kind: "visit", npc: NPC.willem, at: AT.willem, accept: [783, 5261] },
    { kind: "visit", npc: NPC.mcbride, at: AT.mcbride, turnIn: [783], accept: [7] },
    { kind: "visit", npc: NPC.eagan, at: AT.eagan, turnIn: [5261], accept: [33] },
    { kind: "objectives", quests: [7, 33], drops: [MOB.youngWolf, MOB.timberWolf], areas: [...GROUND.vineyardEast, ...GROUND.wolves] },
    { kind: "visit", npc: NPC.eagan, at: AT.eagan, turnIn: [33] },
    // The class letter is McBride's to offer once 7 is in (models' runs took it here, beside 15).
    { kind: "visit", npc: NPC.mcbride, at: AT.mcbride, turnIn: [7], accept: [15, 3101] },
    { kind: "visit", npc: NPC.sammuel, at: AT.sammuel, turnIn: [3101] },
    { kind: "visit", npc: NPC.willem, at: AT.willem, accept: [18, 3903] },
    { kind: "objectives", quests: [15], areas: GROUND.koboldCamp },
    { kind: "visit", npc: NPC.mcbride, at: AT.mcbride, turnIn: [15], accept: [21] },
    { kind: "visit", npc: NPC.milly, at: AT.milly, turnIn: [3903], accept: [3904] },
    { kind: "train", npc: NPC.sammuel, at: AT.sammuel, minLevel: 4 },
    { kind: "objectives", quests: [18, 3904], drops: [MOB.defiasThug], areas: GROUND.vineyardSouth },
    { kind: "visit", npc: NPC.milly, at: AT.milly, turnIn: [3904], accept: [3905] },
    { kind: "visit", npc: NPC.neals, at: AT.neals, turnIn: [3905] },
    { kind: "visit", npc: NPC.willem, at: AT.willem, turnIn: [18], accept: [6] },
    { kind: "objectives", quests: [21], areas: GROUND.echoRidge },
    { kind: "objectives", quests: [6], drops: [MOB.garrick], areas: GROUND.vineyardSouth, maxMinutes: 8 },
    { kind: "visit", npc: NPC.willem, at: AT.willem, turnIn: [6] },
    { kind: "visit", npc: NPC.mcbride, at: AT.mcbride, turnIn: [21], accept: [54] },
    { kind: "vendor", npc: NPC.janos, at: AT.janos },
    { kind: "train", npc: NPC.sammuel, at: AT.sammuel, minLevel: 4 },
    { kind: "travel", via: TO_GOLDSHIRE },
    { kind: "visit", npc: NPC.dughan, at: AT.goldshire, turnIn: [54], accept: [62, 35] },
    { kind: "visit", npc: NPC.remy, at: AT.goldshire, accept: [47, 40] },
    { kind: "visit", npc: NPC.pestle, at: AT.goldshire, accept: [60] },
    { kind: "train", npc: NPC.wilhelm, at: AT.goldshire, minLevel: 6 },
    {
      kind: "objectives",
      quests: [47, 60],
      drops: [MOB.koboldTunneler, MOB.koboldMiner, MOB.koboldVermin, MOB.koboldWorker],
      areas: GROUND.elwynn,
      maxMinutes: 20,
    },
    { kind: "visit", npc: NPC.remy, at: AT.goldshire, turnIn: [47] },
    { kind: "visit", npc: NPC.pestle, at: AT.goldshire, turnIn: [60] },
    { kind: "train", npc: NPC.wilhelm, at: AT.goldshire, minLevel: 8 },
    {
      kind: "grind",
      targets: [
        MOB.koboldTunneler,
        MOB.koboldMiner,
        MOB.koboldVermin,
        MOB.koboldWorker,
        MOB.defiasBandit,
        MOB.forestSpider,
        MOB.youngForestBear,
        MOB.mangyWolf,
        MOB.prowler,
        MOB.timberWolf,
        MOB.koboldLaborer,
        MOB.defiasThug,
      ],
      // Elwynn's grounds are the unverified ones; the observed Northshire
      // grounds close the loop, so a hunt that finds nothing there still finds
      // something before the no-XP watchdog does.
      areas: [...GROUND.elwynn, ...GROUND.vineyardSouth, ...GROUND.echoRidge],
    },
  ],
};

/** The route a `--driver reference` run plays. One today; a second would be a launch flag. */
export const REFERENCE_ROUTE: Route = NORTHSHIRE_PALADIN;

/** The `model` a reference run carries: the route's id and version, so each route is its own line. */
export function referenceModelId(route: Route): string {
  return `reference/${route.id}@${route.version}`;
}
