/**
 * The checked-in campaign definitions: pinned, well-formed, legal, and the
 * read-time rules that attach a run to one.
 *
 * The pins are the point. A published version is never edited (operator
 * decision, 2026-10-09): a change to what a cell means is a new version,
 * because a cell that changes under the same id silently re-scopes every run
 * already recorded against it. So every `id@version`'s content hash is written
 * down here, and editing a definition fails this file until whoever edited it
 * either reverts or adds a version — never by updating the pin of a version
 * that has runs.
 */

import { describe, expect, test } from "bun:test";
import {
  CAMPAIGN_DEFS,
  CAMPAIGN_NAME,
  attributeCampaign,
  campaignDef,
  campaignHash,
  campaignRef,
  campaignVersions,
  parseCampaignRef,
  startMismatch,
  unversionedOwner,
} from "../src/campaign-defs";

/** Every published version's content hash. Add a line for a new version; never edit one. */
const PINS: Record<string, string> = {
  "race-probe@1": "sha256:0afde4ea9263a43e",
  "class-probe@2": "sha256:8bbcf8092520721b",
  "class-probe@1": "sha256:d2dc4bf013c2b7c7",
  "nav-probe@1": "sha256:1127776d492bf5b4",
  "loop-spike@1": "sha256:d7779df4611edc9d",
};

/**
 * The race/class pairs 3.3.5a creates, from AzerothCore's `playercreateinfo`
 * as the live world database holds it (read 2026-10-09). Death Knight (6) is
 * left out: the server creates one only on an account that already holds a
 * level-55 character, and it starts at 55.
 */
const LEGAL: Record<number, readonly number[]> = {
  1: [1, 2, 4, 5, 8, 9], // Human
  2: [1, 3, 4, 7, 9], // Orc
  3: [1, 2, 3, 4, 5], // Dwarf
  4: [1, 3, 4, 5, 11], // Night Elf
  5: [1, 4, 5, 8, 9], // Undead
  6: [1, 3, 7, 11], // Tauren
  7: [1, 4, 8, 9], // Gnome
  8: [1, 3, 4, 5, 7, 8], // Troll
  10: [2, 3, 4, 5, 8, 9], // Blood Elf
  11: [1, 2, 3, 5, 7, 8], // Draenei
};

describe("the pins", () => {
  test("every published version's content is exactly what was published", () => {
    const actual = Object.fromEntries(CAMPAIGN_DEFS.map((d) => [campaignRef(d), campaignHash(d)]));
    expect(actual).toEqual(PINS);
  });

  test("the hash is a function of content, not of key order", () => {
    const d = campaignDef("race-probe", 1)!;
    const reordered = Object.fromEntries(Object.entries(d).reverse()) as typeof d;
    expect(campaignHash(reordered)).toBe(campaignHash(d));
    expect(campaignHash({ ...d, question: `${d.question}!` })).not.toBe(campaignHash(d));
  });
});

describe("the registry", () => {
  test("one definition per id@version, versions numbered from 1 with no gaps", () => {
    const refs = CAMPAIGN_DEFS.map(campaignRef);
    expect(new Set(refs).size).toBe(refs.length);
    for (const id of new Set(CAMPAIGN_DEFS.map((d) => d.id))) {
      expect(campaignVersions(id).map((d) => d.version)).toEqual(campaignVersions(id).map((_, i) => i + 1));
    }
  });

  test("at most one version of an id claims its unversioned runs", () => {
    for (const id of new Set(CAMPAIGN_DEFS.map((d) => d.id))) {
      expect(campaignVersions(id).filter((d) => d.legacy?.unversioned === true).length).toBeLessThanOrEqual(1);
    }
  });

  test("ids and cell ids are names a run id and a path survive, and cells are unique per version", () => {
    for (const d of CAMPAIGN_DEFS) {
      expect(d.id).toMatch(CAMPAIGN_NAME);
      const ids = d.cells.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(CAMPAIGN_NAME);
    }
  });

  test("every open definition's cell is a start the server creates", () => {
    for (const d of CAMPAIGN_DEFS.filter((x) => x.status === "open")) {
      for (const c of d.cells) expect(LEGAL[c.race] ?? []).toContain(c.class);
    }
  });

  test("a listed member is listed once, under a cell its definition declares", () => {
    const seen = new Set<string>();
    for (const d of CAMPAIGN_DEFS) {
      if (d.status !== "closed") continue;
      for (const m of d.legacy.members ?? []) {
        expect(seen.has(m.runId)).toBe(false);
        seen.add(m.runId);
        expect(d.cells.map((c) => c.id)).toContain(m.cell);
      }
    }
  });
});

describe("the two to-level-10 campaigns, as drafted", () => {
  const TO_10 = {
    status: "open",
    objective: null,
    stopAtLevel: 10,
    budget: { episodeMs: 43_200_000, idleMs: 1_200_000, noXpMs: null, maxToolCalls: 24_000 },
    wikiCoords: false,
    wiki: true,
    resume: true,
    maxAttemptsPerCell: 3,
  };

  test("race-probe@1 holds the class at Warrior across all ten races, a Blood Elf Rogue the one substitute", () => {
    const d = campaignDef("race-probe", 1)!;
    expect(d).toMatchObject(TO_10);
    expect(d.cells.map((c) => [c.id, c.race, c.class])).toEqual([
      ["human-warrior", 1, 1],
      ["dwarf-warrior", 3, 1],
      ["gnome-warrior", 7, 1],
      ["nightelf-warrior", 4, 1],
      ["draenei-warrior", 11, 1],
      ["orc-warrior", 2, 1],
      ["troll-warrior", 8, 1],
      ["undead-warrior", 5, 1],
      ["tauren-warrior", 6, 1],
      ["bloodelf-rogue", 10, 4],
    ]);
  });

  test("class-probe@2 holds Coldridge for seven classes, with the only Alliance shaman and druid", () => {
    const d = campaignDef("class-probe", 2)!;
    expect(d).toMatchObject(TO_10);
    expect(d.cells.map((c) => [c.id, c.race, c.class])).toEqual([
      ["dwarf-warrior", 3, 1],
      ["dwarf-paladin", 3, 2],
      ["dwarf-hunter", 3, 3],
      ["dwarf-rogue", 3, 4],
      ["dwarf-priest", 3, 5],
      ["gnome-mage", 7, 8],
      ["gnome-warlock", 7, 9],
      ["draenei-shaman", 11, 7],
      ["nightelf-druid", 4, 11],
    ]);
  });

  test("class-probe@1 is closed history that claims the unversioned class-probe runs", () => {
    const v1 = campaignDef("class-probe", 1)!;
    expect(v1.status).toBe("closed");
    expect(unversionedOwner("class-probe")).toBe(v1);
    expect(unversionedOwner("nav-probe")).toBe(campaignDef("nav-probe", 1));
    expect(unversionedOwner("race-probe")).toBeUndefined();
  });
});

describe("parsing id@version", () => {
  test("a version must be named; a bare id is refused", () => {
    expect(parseCampaignRef("race-probe@1")).toEqual({ id: "race-probe", version: 1 });
    expect(parseCampaignRef("race-probe")).toBeNull();
    expect(parseCampaignRef("race-probe@0")).toBeNull();
    expect(parseCampaignRef("race-probe@latest")).toBeNull();
  });
});

describe("read-time attribution", () => {
  const run = (runId: string, campaign: string | null, campaignVersion: number | null, cell: string | null) => ({ runId, campaign, campaignVersion, cell });

  test("the nine hand-launched spike probes belong to loop-spike@1, by run id", () => {
    const nine = [
      ["probe-workspace-20260925", "workspace"],
      ["probe-spike-20260925-1", "entrypoint"],
      ["probe-spike-20260926-2b", "entrypoint"],
      ["probe-spike-20260926-3", "entrypoint"],
      ["probe-spike-20260926-5", "entrypoint"],
      ["probe-ref05-20260926", "reference-0.5"],
      ["probe-05fix-20260926-1", "0.5-fixes"],
      ["probe-05fix-20260926-2", "0.5-fixes"],
      ["probe-05fix-20260926-3", "0.5-fixes"],
    ] as const;
    for (const [runId, cell] of nine) {
      expect(attributeCampaign(run(runId, null, null, null))).toEqual({ campaign: "loop-spike", version: 1, cell, source: "listed" });
    }
  });

  test("a run stamped with the id and no version is the claiming version's", () => {
    expect(attributeCampaign(run("fleet-x-class-probe-nightelf-hunter-a48", "class-probe", null, "nightelf-hunter"))).toEqual({
      campaign: "class-probe",
      version: 1,
      cell: "nightelf-hunter",
      source: "unversioned",
    });
    expect(attributeCampaign(run("fleet-nav-probe-coldridge-sonnet-20260824", "nav-probe", null, "coldridge"))).toMatchObject({ version: 1, source: "unversioned" });
  });

  test("a stamp wins, and a stamped id nobody claims keeps no version", () => {
    expect(attributeCampaign(run("r", "class-probe", 2, "dwarf-rogue"))).toEqual({ campaign: "class-probe", version: 2, cell: "dwarf-rogue", source: "stamped" });
    expect(attributeCampaign(run("r", "adhoc", null, "c"))).toEqual({ campaign: "adhoc", version: null, cell: "c", source: "stamped" });
  });

  test("a run nothing claims stays unattributed", () => {
    expect(attributeCampaign(run("fleet-sonnet-e90-20261001", null, null, null))).toBeNull();
  });

  test("a recorded start that is not the cell's is flagged, and an unrecorded one is not", () => {
    // class-probe v1's nightelf-hunter cell ran its first three runs as Night Elf Rogues.
    const hunter = campaignDef("class-probe", 1)!.cells.find((c) => c.id === "nightelf-hunter");
    expect(startMismatch(hunter, { race: 4, class: 4 })).toBe(true);
    expect(startMismatch(hunter, { race: 4, class: 3 })).toBe(false);
    expect(startMismatch(hunter, { race: null, class: null })).toBe(false);
    expect(startMismatch(undefined, { race: 4, class: 4 })).toBe(false);
  });
});
