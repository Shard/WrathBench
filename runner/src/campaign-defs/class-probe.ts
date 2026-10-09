/**
 * class-probe: what changes when the class changes?
 *
 * v1 is history. It lived only in the fleet config and was edited in place
 * while it ran, so it is checked in as it last stood and closed: its runs were
 * stamped `class-probe` with no version, which `legacy.unversioned` reads as
 * v1, and nothing launches it again.
 *
 * v2 asks the question to level 10, holding the START ZONE constant where the
 * class allows it rather than the race: the start shapes levels 1–10 more than
 * racials do. Coldridge Valley covers seven of the nine classes (Dwarf for
 * Warrior, Paladin, Hunter, Rogue and Priest; Gnome for Mage and Warlock); the
 * only Alliance shaman is a Draenei and the only Alliance druid a Night Elf, so
 * those two cells start in Ammen Vale and Shadowglen. Death Knight is left out:
 * the server creates one only on an account that already holds a level-55
 * character, and it starts at 55. `dwarf-paladin` is the subscription lanes'
 * scored start, so it is the cell a model's probe can be read against its own
 * e360 curve on.
 */

import { TO_LEVEL_10 } from "./shapes";
import type { ClosedCampaignDef, OpenCampaignDef } from "./types";

export const CLASS_PROBE_V1 = {
  id: "class-probe",
  version: 1,
  status: "closed",
  question: "With no objective and the probing episode's 90-minute default, what does each of eight race/class starts reach?",
  cells: [
    { id: "human-warrior", race: 1, class: 1 },
    { id: "dwarf-rogue", race: 3, class: 4 },
    { id: "nightelf-druid", race: 4, class: 11 },
    { id: "gnome-mage", race: 7, class: 8 },
    { id: "human-warlock", race: 1, class: 9 },
    { id: "dwarf-paladin", race: 3, class: 2 },
    {
      id: "nightelf-hunter",
      race: 4,
      class: 3,
      note: "Declared as class 4 (Rogue) when its first runs launched and corrected under the same id; those runs are Night Elf Rogues and read as such.",
    },
    { id: "human-priest", race: 1, class: 5 },
  ],
  legacy: { unversioned: true },
  history:
    "Lived only in the fleet config, edited in place while it ran: maxAttemptsPerCell was added after its first runs, one cell's class changed under the same id, and its model list was replaced. Checked in as it last stood; v1 is a label over a definition no run was stamped with.",
} as const satisfies ClosedCampaignDef;

export const CLASS_PROBE_V2 = {
  id: "class-probe",
  version: 2,
  status: "open",
  question: "From one start zone where the class allows it, how long does each class take to reach level 10?",
  cells: [
    { id: "dwarf-warrior", race: 3, class: 1 },
    { id: "dwarf-paladin", race: 3, class: 2, note: "The subscription lanes' scored start: the calibration cell." },
    { id: "dwarf-hunter", race: 3, class: 3 },
    { id: "dwarf-rogue", race: 3, class: 4 },
    { id: "dwarf-priest", race: 3, class: 5 },
    { id: "gnome-mage", race: 7, class: 8 },
    { id: "gnome-warlock", race: 7, class: 9 },
    { id: "draenei-shaman", race: 11, class: 7, note: "The only Alliance shaman; starts in Ammen Vale." },
    { id: "nightelf-druid", race: 4, class: 11, note: "The only Alliance druid; starts in Shadowglen." },
  ],
  ...TO_LEVEL_10,
} as const satisfies OpenCampaignDef;
