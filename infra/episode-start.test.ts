/**
 * The start keys of a roster entry, from the fleet's side (operator,
 * 2026-11-15): `race` and `class` set a freeplay start and nothing a level
 * episode plays, whose start is its id's; `chooseStart` lets a freeplay run's
 * model choose. The argv the roster emits, the dry run's line and `fleet
 * status` all say which start a launch gets.
 */

import { describe, expect, test } from "bun:test";
import { configFromArgs } from "../runner/src/run";
import { rosterEntryRefusal } from "../runner/src/roster-refusal";
import { validateEntries, type FleetJob, type FleetRosterEntry } from "./run-fleet-config";
import { jobSpawn } from "./run-fleet-plan";
import { formatStartKeys } from "./run-fleet-status";
import { episodeFlags, ignoredStart, resolve, startLine, type Resolved, type RosterSpec } from "./run-roster";

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
  });

  test("the dry run says where the start came from and what of the entry's it ignores", () => {
    const e90 = specOf(job({ ref: "opus", episode: "e90", attempt: 1 }));
    expect(e90.startIgnored).toBe("the entry's race 3, class 2 is ignored: e90 fixes race 1, class 2");
    expect(startLine(e90)).toBe("race 1, class 2 fixed by the episode (e90) — the entry's race 3, class 2 is ignored: e90 fixes race 1, class 2");
    // e360's own start, restated, is nothing ignored.
    expect(specOf(job({ ref: "opus", episode: "e360", attempt: 1 })).startIgnored).toBeUndefined();
    expect(startLine(specOf(job({ ref: "glm", episode: "e90", attempt: 1 })))).toBe("race 1, class 2 fixed by the episode (e90)");
    expect(startLine(specOf(job({ ref: "chooser", episode: "e90", attempt: 1 })))).toBe(
      "race 1, class 2 fixed by the episode (e90) — the entry's chooseStart is ignored: e90 fixes race 1, class 2",
    );
  });

  test("a hand-written roster on e90 with another race is launched on the episode's, not refused", () => {
    const [s] = resolve([{ model: "x/y", episode: "e90", race: 4, class: 11 } as RosterSpec], STAMP);
    expect(flagValue(episodeFlags(s!, false), "--race")).toBe("1");
    expect(flagValue(episodeFlags(s!, false), "--class")).toBe("2");
  });
});

describe("the entry's start keys are its freeplay start", () => {
  test("freeplay launches the entry's race and class; with none, the default", () => {
    const opus = specOf(job({ ref: "opus", episode: "freeplay", attempt: 1 }));
    expect(opus).toMatchObject({ race: 3, class: 2, startFrom: "entry", startIgnored: undefined });
    expect(flagValue(episodeFlags(opus, false), "--race")).toBe("3");
    expect(startLine(specOf(job({ ref: "glm", episode: "freeplay", attempt: 1 })))).toBe("race 1, class 2 fixed by default");
  });

  test("chooseStart on freeplay passes --choose-start and no race or class", () => {
    const s = specOf(job({ ref: "chooser", episode: "freeplay", attempt: 1 }));
    expect(s.chooseStart).toBe(true);
    const argv = episodeFlags(s, false);
    expect(flagValue(argv, "--choose-start")).toBe("true");
    expect(argv).not.toContain("--race");
    expect(argv).not.toContain("--class");
    expect(configFromArgs(argv)).toMatchObject({ episode: "freeplay", chooseStart: true });
    expect(startLine(s)).toBe("race and class chosen by the model at createSession (the entry's chooseStart)");
    // A resume restates nothing: the run's own config says it chose.
    expect(episodeFlags(s, true)).not.toContain("--choose-start");
  });

  test("chooseStart is ignored where the run is not freeplay", () => {
    expect(ignoredStart({ chooseStart: true }, undefined)).toBe("the entry's chooseStart is ignored: only a freeplay run lets the model choose");
    const [hand] = resolve([{ model: "x/y", chooseStart: true } as RosterSpec], STAMP);
    expect(hand!.chooseStart).toBe(false);
    expect(episodeFlags(hand!, false)).toContain("--race");
  });
});

describe("the entry's keys are checked where the roster is read", () => {
  const entry = (over: Record<string, unknown>): unknown[] => [{ model: "x/y", ...over }];

  test("race and class are the client's numeric ids; chooseStart is true or absent, and never beside them", () => {
    expect(() => validateEntries("roster:x", entry({ race: "choose" }))).toThrow("race must be the client's numeric id, 1-11 (to let the model choose, set chooseStart: true)");
    expect(() => validateEntries("roster:x", entry({ class: 12 }))).toThrow("class must be the client's numeric id");
    expect(() => validateEntries("roster:x", entry({ chooseStart: "yes" }))).toThrow("chooseStart is true or absent");
    expect(() => validateEntries("roster:x", entry({ chooseStart: true, race: 3 }))).toThrow("cannot also state race or class");
    expect(validateEntries("roster:x", entry({ race: 3, class: 2 }))).toHaveLength(1);
    expect(validateEntries("roster:x", entry({ chooseStart: true }))).toHaveLength(1);
  });

  test("chooseStart is a key an entry may carry", () => {
    expect(rosterEntryRefusal({ model: "x/y", chooseStart: true } as never, [])).toBeNull();
  });
});

describe("fleet status names the start keys", () => {
  test("the episodes' starts once, then every entry that carries one, as a freeplay start", () => {
    expect(formatStartKeys(ROSTER)).toEqual([
      "start: e90 Human Paladin (race 1, class 2), e360 Dwarf Paladin (race 3, class 2) for every model; an entry's race, class or chooseStart is its freeplay start only",
      "  opus: race 3, class 2 — freeplay only",
      "  chooser: chooseStart — the model chooses its race and class on freeplay",
    ]);
    expect(formatStartKeys({ glm: ROSTER["glm"]! })).toEqual([]);
  });
});
