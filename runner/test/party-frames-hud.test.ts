/**
 * The HUD's party line (#286): each other member's state, health while
 * alive, and where it is — off its unit while in view, off the party frame
 * the server sends while it is out of sight. Names and positions are invented.
 */
import { describe, expect, test } from "bun:test";

import { formatStateSummary, type SnapshotLike } from "../src/context";

const partyOf = (members: NonNullable<NonNullable<SnapshotLike["group"]>["members"]>, units: SnapshotLike["units"] = []): SnapshotLike => ({
  self: { name: "Fenwick", guid: "7" },
  group: { inGroup: true, members },
  units,
});
const partyLine = (snap: SnapshotLike): string | undefined =>
  formatStateSummary(snap, { sessionLive: true })
    .split("\n")
    .find((l) => l.startsWith("party: "));

describe("party: the party frames", () => {
  test("absent outside a group, and for a group with nobody else listed", () => {
    expect(partyLine({ self: { name: "Fenwick" } })).toBeUndefined();
    expect(partyLine({ group: { inGroup: false, members: [] } })).toBeUndefined();
    expect(partyLine({ group: { inGroup: true, members: [] } })).toBeUndefined();
  });

  test("a member in view reads off its unit: state, health and distance", () => {
    const line = partyLine(
      partyOf(
        [
          { guid: "941", name: "Ysolde", online: true, inView: true },
          { guid: "942", name: "Corwin", online: true, inView: true },
          { guid: "943", name: "Merrit", online: true, inView: true },
        ],
        [
          { guid: "941", name: "Ysolde", type: "player", distance: 14.4, health: 261, maxHealth: 300, ghost: false },
          { guid: "942", name: "Corwin", type: "player", distance: 30.2, health: 0, maxHealth: 400, dead: true, ghost: false },
          { guid: "943", name: "Merrit", type: "player", distance: 5, health: 1, maxHealth: 400, ghost: true },
        ],
      ),
    );
    expect(line).toBe("party: Ysolde alive 87% 14y; Corwin dead 30y; Merrit ghost 5y");
  });

  test("a member out of view reads off its party frame: zone and position, no distance", () => {
    const line = partyLine(
      partyOf([
        {
          guid: "940",
          name: "Brannoc",
          online: true,
          inView: false,
          stats: { online: true, ghost: true, dead: false, health: 1, maxHealth: 515, zone: { id: 40, name: "Westfall" }, position: { x: -10546, y: 1197 } },
        },
        {
          guid: "941",
          name: "Ysolde",
          online: true,
          inView: false,
          stats: { online: true, ghost: false, dead: false, health: 186, maxHealth: 300, zone: { id: 1581, name: "The Fixture Mine" }, position: { x: -16, y: -383 } },
        },
        { guid: "942", name: "Corwin", online: true, inView: false, stats: { online: true, ghost: false, dead: true, health: 0, maxHealth: 400, zone: { id: 9999 } } },
      ]),
    );
    expect(line).toBe(
      "party: Brannoc ghost, Westfall (-10546, 1197), out of view; Ysolde alive 62%, The Fixture Mine (-16, -383), out of view; Corwin dead, zone 9999, out of view",
    );
  });

  test("offline from the group list or from the party frame; out of view with nothing sent yet", () => {
    const line = partyLine(
      partyOf([
        { guid: "940", name: "Brannoc", online: false, inView: false },
        { guid: "941", name: "Ysolde", online: true, inView: false, stats: { online: false, health: 300, maxHealth: 300 } },
        { guid: "942", name: "Corwin", online: true, inView: false },
        { guid: "943", name: "Merrit", online: true, inView: false, stats: { position: { x: 12, y: -40 } } },
      ]),
    );
    expect(line).toBe("party: Brannoc offline; Ysolde offline; Corwin out of view; Merrit, (12, -40), out of view");
  });

  test("the line sits under the player frame, after health and auras", () => {
    const text = formatStateSummary(partyOf([{ guid: "940", name: "Brannoc", online: false }]), { sessionLive: true });
    const lines = text.split("\n");
    const health = lines.findIndex((l) => l.startsWith("health: "));
    expect(lines[health + 1]).toBe("party: Brannoc offline");
  });
});
