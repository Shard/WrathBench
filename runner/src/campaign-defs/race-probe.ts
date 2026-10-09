/**
 * race-probe: what changes when the race — and with it the start zone —
 * changes?
 *
 * The class is held at Warrior, the only class (Death Knight aside) that nine
 * of the ten races can play. A Blood Elf cannot be a warrior in 3.3.5a, so its
 * cell is a Rogue: the nearest melee class with no self-heal and no pet, which
 * keeps the early downtime curve closest to a warrior's. Dwarf and Gnome share
 * Coldridge Valley and Orc and Troll share the Valley of Trials, so two pairs
 * separate race from zone for free. The Alliance cells come first: no run has
 * driven a Horde character or started on map 530 before this campaign, and a
 * sweep that trips on one should already hold the tested faction.
 */

import { TO_LEVEL_10 } from "./shapes";
import type { OpenCampaignDef } from "./types";

export const RACE_PROBE_V1 = {
  id: "race-probe",
  version: 1,
  status: "open",
  question: "With the class held at Warrior, how long does each race's own start take to reach level 10?",
  cells: [
    { id: "human-warrior", race: 1, class: 1 },
    { id: "dwarf-warrior", race: 3, class: 1 },
    { id: "gnome-warrior", race: 7, class: 1 },
    { id: "nightelf-warrior", race: 4, class: 1 },
    { id: "draenei-warrior", race: 11, class: 1 },
    { id: "orc-warrior", race: 2, class: 1 },
    { id: "troll-warrior", race: 8, class: 1 },
    { id: "undead-warrior", race: 5, class: 1 },
    { id: "tauren-warrior", race: 6, class: 1 },
    {
      id: "bloodelf-rogue",
      race: 10,
      class: 4,
      note: "A Blood Elf cannot be a warrior in 3.3.5a; rogue is the nearest no-heal melee.",
    },
  ],
  ...TO_LEVEL_10,
} as const satisfies OpenCampaignDef;
