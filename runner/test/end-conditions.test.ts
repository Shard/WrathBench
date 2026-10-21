/**
 * A campaign's ends (`end-conditions.ts`): the definition field, the run's
 * config, the watchdog that ends a run on one, and the reading of a recorded
 * trajectory after the fact. Fixture-based; every guid is invented except the
 * shape of a creature guid (high 0xF130, entry in bits 24..47).
 */

import { describe, expect, test } from "bun:test";
import { campaignDefinitionSchema, campaignHash, cellDimensions } from "../src/campaign-def";
import { watchdogConfigSchema } from "../src/config";
import {
  creatureEntryOfGuid,
  endConditionsOf,
  endFromMilestones,
  isEndReason,
  killEndMet,
  levelTargetOf,
  type EndMilestone,
} from "../src/end-conditions";
import { isCounted, type RunFact } from "../src/models";
import { Watchdogs } from "../src/watchdogs";
import { checkedIn, definition, partyDefinition } from "./fixtures/campaigns";

const cfg = watchdogConfigSchema.parse({ idleMs: 600_000, noXpMs: null, episodeMs: 3_600_000, maxSandboxRestarts: 3 });
/** A creature guid carrying entry 639. */
const VANCLEEF = "17379390972743385188";

describe("the definition's end", () => {
  test("a kill end parses, hashes, and reaches the run's config; a definition without one hashes as before", () => {
    const def = partyDefinition({ end: [{ kill: { entry: 639 } }] });
    expect(endConditionsOf(def)).toEqual([{ kill: { entry: 639 } }]);
    expect(cellDimensions(def, def.cells[0]!, def.party!.members[0])).toMatchObject({ end: [{ kill: { entry: 639 } }] });
    expect(cellDimensions(def, def.cells[0]!, def.party!.members[0])).not.toHaveProperty("stopAtLevel");
    // `end` absent is no key at all: the hash is the one the file always had.
    const plain = partyDefinition();
    expect(plain).not.toHaveProperty("end");
    expect(campaignHash(plain)).toBe(campaignHash(campaignDefinitionSchema.parse(JSON.parse(JSON.stringify(plain)))));
    expect(campaignHash(def)).not.toBe(campaignHash(plain));
  });

  test("stopAtLevel is still a level end, and a level in both spellings is refused", () => {
    const def = definition({ stopAtLevel: 10 });
    expect(endConditionsOf(def)).toEqual([{ level: 10 }]);
    expect(cellDimensions(def, def.cells[0]!)).toMatchObject({ stopAtLevel: 10 });
    const both = campaignDefinitionSchema.safeParse({ ...definition(), stopAtLevel: 10, end: [{ level: 12 }] });
    expect(both.success).toBe(false);
    expect(campaignDefinitionSchema.safeParse({ ...definition(), stopAtLevel: 10, end: [{ kill: { entry: 639 } }] }).success).toBe(true);
    expect(campaignDefinitionSchema.safeParse({ ...definition(), stopAtLevel: null, end: [] }).success).toBe(false);
    expect(campaignDefinitionSchema.safeParse({ ...definition(), stopAtLevel: null, end: [{ kill: { entry: 0 } }] }).success).toBe(false);
    expect(levelTargetOf(endConditionsOf({ stopAtLevel: null, end: [{ level: 12 }, { kill: { entry: 639 } }] }))).toBe(12);
  });

  test("deadmines@4 is @3 with VanCleef's kill as its end", () => {
    const v3 = checkedIn("deadmines@3");
    const v4 = checkedIn("deadmines@4");
    expect(v4.version).toBe(4);
    expect(v4.end).toEqual([{ kill: { entry: 639 } }]);
    expect(v3.end).toBeUndefined();
    const { version: _a, note: _b, end: _c, ...rest4 } = v4;
    const { version: _d, note: _e, ...rest3 } = v3;
    expect(rest4).toEqual(rest3);
    expect(v4.note).toStartWith(v3.note!);
  });
});

describe("the watchdog", () => {
  test("a level end still ends the run as level-target", () => {
    const w = new Watchdogs(cfg, () => 0, 0, { stopAtLevel: 10 });
    w.noteProgress(9, 100);
    expect(w.check()).toBeNull();
    w.noteProgress(10, 0);
    expect(w.check()?.reason).toBe("level-target");
    const v = new Watchdogs(cfg, () => 0, 0, { end: [{ level: 5 }] });
    v.noteProgress(5, 0);
    expect(v.check()?.reason).toBe("level-target");
  });

  test("a kill end ends on a member's kill of the entry, and on nothing else", () => {
    const w = new Watchdogs(cfg, () => 0, 0, { end: [{ kill: { entry: 639 } }] });
    // Another creature, and the boss killed by someone outside the group.
    w.noteKill({ killerGuid: "980", victimGuid: "4000", entry: 636, self: false, member: true });
    w.noteKill({ killerGuid: "1234", victimGuid: VANCLEEF, entry: 639, self: false, member: false });
    expect(w.check()).toBeNull();
    // A member out of sight: no entry from the cache, the guid's own.
    w.noteKill({ killerGuid: "980", victimGuid: VANCLEEF, self: false, member: true });
    expect(w.check()).toEqual({ reason: "kill-target", detail: "entry 639 killed (killer party member 980)" });
  });

  test("a run with no end ignores every kill; kill-target is an end reason and counts", () => {
    const w = new Watchdogs(cfg, () => 0);
    w.noteKill({ killerGuid: "7", victimGuid: VANCLEEF, entry: 639, self: true, member: true });
    expect(w.check()).toBeNull();
    expect(isEndReason("kill-target")).toBe(true);
    expect(isEndReason("level-target")).toBe(true);
    expect(isEndReason("party-ended")).toBe(false);
    const fact = { extra: false, episodeOverride: false, driver: "claude-code", live: false, pause: null, modelResponses: 40, terminationReason: "kill-target" } as unknown as RunFact;
    expect(isCounted(fact)).toBe(true);
  });
});

describe("reading a recorded trajectory", () => {
  test("a creature guid names its entry; other guids name none", () => {
    expect(creatureEntryOfGuid(VANCLEEF)).toBe(639);
    expect(creatureEntryOfGuid("980")).toBeUndefined();
    expect(creatureEntryOfGuid("not a guid")).toBeUndefined();
  });

  test("an ended run's milestones say whether it reached its end, folding the group for a record from before `member`", () => {
    const ends = [{ kill: { entry: 639 } }];
    const ms: EndMilestone[] = [
      { kind: "group", event: "joined", members: ["981", "978", "979", "980"] },
      { kind: "kill", killerGuid: "982", victimGuid: "4000", entry: 657, self: true, observedTs: 100 },
      { kind: "kill", killerGuid: "980", victimGuid: VANCLEEF, entry: 639, self: false, observedTs: 200 },
      { kind: "level", to: 21 },
    ];
    expect(endFromMilestones(ends, ms)).toEqual({ reason: "kill-target", detail: "entry 639 killed (killer party member 980)", observedTs: 200 });
    // The same kill by someone who is no member, or after the group was left: no end.
    expect(endFromMilestones(ends, [ms[0]!, { kind: "kill", killerGuid: "1234", victimGuid: VANCLEEF, entry: 639, self: false }])).toBeNull();
    expect(endFromMilestones(ends, [ms[0]!, { kind: "group", event: "left", members: [] }, ms[2]!])).toBeNull();
    expect(endFromMilestones([{ level: 21 }], ms)).toMatchObject({ reason: "level-target" });
    expect(killEndMet(ends, { killerGuid: "980", victimGuid: VANCLEEF, self: false }, new Set(["980"]))).toEqual({ entry: 639 });
  });
});
