/**
 * The runner's own fan-out wording (`fanout-wording.ts`): today's stack
 * default byte for byte, held two ways. Literal goldens pin the bytes, so a
 * change to the runner's copy is a deliberate edit of this file; and the
 * stack's own output on the same inputs is compared, so a stack bump that
 * moves its default is seen here rather than passing silently into or out of
 * scored surface. The freeze itself waits on the operator's read of
 * deadmines@5.
 */

import { describe, expect, test } from "bun:test";
import { PLAIN_FANOUT_RENDER, ROLLUP as STACK_ROLLUP, type CharacterDigest, type CharacterView } from "@wrathbench/mcp/fanout";
import { ROLLUP, WRATHBENCH_FANOUT_RENDER } from "../src/fanout-wording";

function d(character: string, over: Partial<CharacterDigest> = {}): CharacterDigest {
  return {
    character,
    inWorld: true,
    connected: true,
    level: 20,
    health: { current: 1000, max: 1000 },
    power: { current: 500, max: 500 },
    mana: true,
    dead: false,
    inCombat: false,
    casting: false,
    map: 36,
    x: -120,
    y: -540,
    zone: "The Deadmines",
    moveRefused: null,
    ...over,
  };
}

const view = (character: string, state: CharacterView["state"] = "in", error?: string): CharacterView => ({ character, state, ...(error !== undefined ? { error } : {}) }) as CharacterView;

const PARTY = ["Tankpartyb", "Healpartyc", "Magepartyd", "Roguepartye", "Palapartyf"];

const CASES: { name: string; digests: CharacterDigest[]; views: CharacterView[] }[] = [
  { name: "nobody", digests: [], views: [] },
  { name: "all well", digests: PARTY.map((c) => d(c)), views: PARTY.map((c) => view(c)) },
  {
    name: "exceptions",
    digests: [
      d("Tankpartyb", { inCombat: true }),
      d("Healpartyc", { dead: true, health: { current: 0, max: 900 }, map: 0, zone: "Westfall" }),
      d("Magepartyd", { health: { current: 220, max: 1000 }, power: { current: 30, max: 900 }, casting: true }),
      d("Roguepartye", { x: 200, y: -540, mana: false, connected: false }),
      d("Palapartyf", { moveRefused: "too_far" }),
    ],
    views: PARTY.map((c) => view(c)),
  },
  {
    name: "detached and out",
    digests: [d("Tankpartyb", { inWorld: false, map: null, x: null, y: null, zone: null }), d("Healpartyc", { level: null, health: null, zone: null })],
    views: [view("Tankpartyb"), view("Healpartyc"), view("Magepartyd", "detached", "login refused"), view("Roguepartye", "out"), view("Palapartyf", "out")],
  },
];

describe("the runner's fan-out wording", () => {
  test("is the stack's default, on every case, for the roll-up, the list and who saw a line", () => {
    for (const c of CASES) {
      expect(WRATHBENCH_FANOUT_RENDER.rollup(c.digests, { maxCharacters: 5, views: c.views })).toBe(PLAIN_FANOUT_RENDER.rollup(c.digests, { maxCharacters: 5, views: c.views }));
      expect(WRATHBENCH_FANOUT_RENDER.list(c.views, c.digests, { maxCharacters: 5 })).toBe(PLAIN_FANOUT_RENDER.list(c.views, c.digests, { maxCharacters: 5 }));
    }
    for (const names of [["Tankpartyb"], ["Tankpartyb", "Healpartyc", "Magepartyd"]]) {
      expect(WRATHBENCH_FANOUT_RENDER.seenBy(names)).toBe(PLAIN_FANOUT_RENDER.seenBy(names));
    }
    expect(ROLLUP).toEqual(STACK_ROLLUP);
  });

  test("is these bytes", () => {
    const [nobody, well, odd, detached] = CASES.map((c) => WRATHBENCH_FANOUT_RENDER.rollup(c.digests, { maxCharacters: 5, views: c.views }));
    expect(nobody).toBe("No character is logged in; use login_character.");
    expect(well).toBe("5 of 5 characters logged in: 5 alive, 0 dead, 0 in combat, 0 casting, 0 out of mana\ngroup: 5 on map 36 around (-120, -540), The Deadmines\nno exceptions");
    expect(odd).toBe(
      [
        "5 of 5 characters logged in: 4 alive, 1 dead, 1 in combat, 1 casting, 1 out of mana",
        "group: 4 on map 36 around (-120, -540), The Deadmines",
        "Healpartyc: dead, on map 0",
        "Magepartyd: health 22%",
        "Roguepartye: disconnected, 320y from the group",
        "Palapartyf: last move too_far",
      ].join("\n"),
    );
    expect(detached).toBe("2 of 5 characters logged in: 1 alive, 0 dead, 0 in combat, 0 casting, 0 out of mana\ngroup: 1 on map 36 around (-120, -540)\nTankpartyb: not in the world\nMagepartyd: not attached (login refused)");
    expect(WRATHBENCH_FANOUT_RENDER.list(CASES[3]!.views, CASES[3]!.digests, { maxCharacters: 5 })).toBe(
      "Tankpartyb: level 20, health 1000/1000\nHealpartyc: map 36\nMagepartyd: not attached (login refused)\n3 of 5 characters logged in.\nNot logged in: Roguepartye, Palapartyf.",
    );
    expect(WRATHBENCH_FANOUT_RENDER.seenBy(["Healpartyc"])).toBe(" [Healpartyc]");
    expect(WRATHBENCH_FANOUT_RENDER.seenBy(["a", "b"])).toBe(" [seen by 2]");
    expect(ROLLUP).toEqual({ LOW_HEALTH: 0.35, OUT_OF_POWER: 0.1, FAR_YARDS: 100 });
  });
});
