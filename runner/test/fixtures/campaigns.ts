/**
 * Campaign definitions as the tests publish them: the checked-in files under
 * `runner/campaigns/`, and small synthetic ones, wrapped the way
 * `campaign-publish.ts` wraps a definition for the store. Shared by the runner
 * and infra suites so both read one shape.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { campaignDefinitionSchema, campaignHash, campaignRef, type CampaignDefinition, type PublishedCampaignDoc } from "../../src/campaign-def";
import { parseCampaignBlocks, type Campaign, type PairRosterEntry, type PublishedCampaign } from "../../src/campaigns";

export const CAMPAIGNS_DIR = join(import.meta.dir, "..", "..", "campaigns");

/** A checked-in definition by `id@version`, parsed. */
export function checkedIn(ref: string): CampaignDefinition {
  return campaignDefinitionSchema.parse(JSON.parse(readFileSync(join(CAMPAIGNS_DIR, `${ref}.json`), "utf8")));
}

/** Every checked-in definition file's name. */
export function checkedInFiles(): string[] {
  return readdirSync(CAMPAIGNS_DIR).filter((f) => f.endsWith(".json")).sort();
}

/** A definition with every field a test does not care about filled in. */
export function definition(over: Partial<CampaignDefinition> = {}): CampaignDefinition {
  return campaignDefinitionSchema.parse({
    id: "probe",
    version: 1,
    question: "q",
    cells: [
      { id: "a", race: 1, class: 1 },
      { id: "b", race: 3, class: 2 },
    ],
    arms: [{ id: "base" }],
    objective: null,
    stopAtLevel: 10,
    budget: { episodeMs: 43_200_000, idleMs: 1_200_000, noXpMs: null, maxToolCalls: 24_000 },
    wiki: true,
    wikiCoords: false,
    resume: true,
    maxAttemptsPerCell: 3,
    ...over,
  });
}

/** The store document a publish writes for a definition. */
export function publication(def: CampaignDefinition, publishedAt = 1_760_000_000_000): PublishedCampaignDoc {
  return {
    definition: def,
    hash: campaignHash(def),
    source: { commit: "0123456789abcdef0123456789abcdef01234567", path: `runner/campaigns/${campaignRef(def)}.json`, branch: ["master"] },
    publishedAt,
  };
}

/** The `campaign-defs` block a config document carries for these definitions. */
export function defsBlock(...defs: CampaignDefinition[]): Record<string, PublishedCampaignDoc> {
  return Object.fromEntries(defs.map((d) => [campaignRef(d), publication(d)]));
}

/** Campaigns joined the way every config reader joins them. */
export function joined(
  defs: readonly CampaignDefinition[],
  rows: Record<string, unknown>,
  roster?: Readonly<Record<string, PairRosterEntry>>,
): { campaigns: Campaign[]; definitions: PublishedCampaign[] } {
  const r = parseCampaignBlocks(defsBlock(...defs), rows, roster);
  return { campaigns: r.campaigns, definitions: r.definitions };
}
