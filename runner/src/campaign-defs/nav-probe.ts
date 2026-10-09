/**
 * nav-probe: can a model travel between capitals on the game's own roads and
 * transport, keeping a log of what worked?
 *
 * Checked in from the shape the config store held when definitions moved into
 * git (2026-10-09), unchanged: one cell, the travel objective, a six-hour
 * clock with the no-XP watchdog off, wiki coordinates served. Its one run
 * (`fleet-nav-probe-coldridge-sonnet-20260824`) was stamped `nav-probe` with
 * no version, which `legacy.unversioned` reads as this version.
 */

import type { OpenCampaignDef } from "./types";

export const NAV_PROBE_V1 = {
  id: "nav-probe",
  version: 1,
  status: "open",
  question:
    "Can a model travel from Coldridge Valley to Ironforge and on to Stormwind by road and the game's own transport, and say what worked?",
  cells: [{ id: "coldridge", race: 3, class: 2 }],
  objective:
    "Travel from Coldridge Valley to Ironforge, then take the Deeprun Tram from Ironforge to Stormwind. Use roads and the game's own transport (the tram; flight masters once discovered). Keep a travel log in the scratchpad: destination chosen, route chosen, what worked, what failed and why. In each city, find the flight master and a trainer and note them in the log. Once in Stormwind, keep exploring and questing there.",
  stopAtLevel: null,
  budget: { episodeMs: 21_600_000, idleMs: 1_200_000, noXpMs: null, maxToolCalls: 2500 },
  wikiCoords: true,
  wiki: true,
  resume: false,
  maxAttemptsPerCell: null,
  legacy: { unversioned: true },
} as const satisfies OpenCampaignDef;
