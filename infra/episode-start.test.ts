/**
 * The start keys of a roster entry, from the fleet's side (operator,
 * 2026-11-15): `race` and `class` set a freeplay start and nothing a level
 * episode plays, whose start is its id's; `chooseStart` lets a freeplay run's
 * model choose. What is pinned is the comparability half: the argv the roster
 * emits for a level episode carries the episode's start, whatever the entry says.
 */

import { describe, expect, test } from "bun:test";
import { configFromArgs } from "../runner/src/run";
import type { FleetJob, FleetRosterEntry } from "./run-fleet-config";
import { jobSpawn } from "./run-fleet-plan";
import { episodeFlags, ignoredStart, resolve, type Resolved, type RosterSpec } from "./run-roster";

const STAMP = "20261115";

const ROSTER: Record<string, FleetRosterEntry> = {
  // A Claude subscription row as the 0.5 roster wrote it: a Dwarf.
  opus: { model: "opus", driver: "claude-code", effort: "low", tier: "t2", idle: "unlimited", race: 3, class: 2 },
  glm: { model: "z-ai/glm-5.2:free", tier: "t1", idle: "unlimited", billing: "free" },
  chooser: { model: "x/chooser:free", tier: "t1", idle: "unlimited", billing: "free", chooseStart: true },
};

function job(over: Partial<FleetJob> & Pick<FleetJob, "ref" | "episode">): FleetJob {
  return { refs: [over.ref], repeat: 1, name: `${over.ref}-${over.episode}`, enabled: true, source: "policy", ...over };
}

const specOf = (j: FleetJob): Resolved => resolve(jobSpawn(j, ROSTER, "RUNNER1", STAMP, () => true).entries, STAMP)[0]!;
const flagValue = (argv: readonly string[], f: string): string | undefined => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

describe("a level episode's start is its id's, whatever the entry says", () => {
  test("an entry with another race launches e90 as a Human Paladin and e360 as a Dwarf Paladin", () => {
    const e90 = specOf(job({ ref: "opus", episode: "e90", attempt: 1 }));
    expect(e90).toMatchObject({ race: 1, class: 2, startFrom: "episode", chooseStart: false });
    const argv = episodeFlags(e90, false);
    expect(flagValue(argv, "--race")).toBe("1");
    expect(flagValue(argv, "--class")).toBe("2");
    // And the runner, given that argv, starts the episode's character.
    expect(configFromArgs(argv)).toMatchObject({ episode: "e90", race: 1, class: 2 });
    const e360 = specOf(job({ ref: "glm", episode: "e360", attempt: 1 }));
    expect(flagValue(episodeFlags(e360, false), "--race")).toBe("3");
    // A model that may choose its start on freeplay does not choose an e90 one.
    const chooser = specOf(job({ ref: "chooser", episode: "e90", attempt: 1 }));
    expect(chooser).toMatchObject({ race: 1, class: 2, chooseStart: false });
    expect(episodeFlags(chooser, false)).not.toContain("--choose-start");
  });

  test("a hand-written roster on e90 with another race is launched on the episode's, not refused", () => {
    const [s] = resolve([{ model: "x/y", episode: "e90", race: 4, class: 11 } as RosterSpec], STAMP);
    expect(flagValue(episodeFlags(s!, false), "--race")).toBe("1");
    expect(flagValue(episodeFlags(s!, false), "--class")).toBe("2");
  });
});

describe("the entry's start keys are its freeplay start", () => {
  test("chooseStart is ignored where the run is not freeplay", () => {
    expect(ignoredStart({ chooseStart: true }, undefined)).toBe("the entry's chooseStart is ignored: only a freeplay run lets the model choose");
    const [hand] = resolve([{ model: "x/y", chooseStart: true } as RosterSpec], STAMP);
    expect(hand!.chooseStart).toBe(false);
    expect(episodeFlags(hand!, false)).toContain("--race");
  });
});

