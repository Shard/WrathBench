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
import type { ConfigStore } from "../../src/config-store";

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

/**
 * Seed a store with a config document the way a deployment gets one: its
 * `campaign-defs` block published first, then the document seeded. A seed
 * writes no definition, and accepts one only as the store already holds it.
 */
export function seedPublished(store: Pick<ConfigStore, "publishDefinition" | "seed">, doc: unknown): void {
  const defs = ((doc as { "campaign-defs"?: unknown })["campaign-defs"] ?? {}) as Record<string, unknown>;
  for (const pub of Object.values(defs)) store.publishDefinition(pub);
  store.seed(doc);
}

/** The five members a party fixture stages: the Deadmines roles, invented names. */
export const PARTY_MEMBERS = [
  { id: "tank", role: "tank", race: 1, class: 1, character: "Aldric", objective: "You are Aldric, the party's tank." },
  { id: "healer", role: "healer", race: 1, class: 5, character: "Brenna", objective: "You are Brenna, the party's healer." },
  { id: "mage", role: "damage", race: 7, class: 8, character: "Corvin", objective: "You are Corvin, the party's damage." },
  { id: "rogue", role: "damage", race: 1, class: 4, character: "Dagny", objective: "You are Dagny, the party's damage." },
  { id: "hunter", role: "damage", race: 3, class: 3, character: "Edrin", objective: "You are Edrin, the party's damage." },
] as const;

/** A party definition: one cell (the party, carrying the leader's start), staged at level 20. */
export function partyDefinition(over: Partial<CampaignDefinition> = {}): CampaignDefinition {
  return definition({
    id: "deadmines",
    cells: [{ id: "party", race: 1, class: 1 }],
    stopAtLevel: null,
    budget: { episodeMs: 14_400_000, idleMs: 1_200_000, noXpMs: null, maxToolCalls: 8000 },
    start: { staged: "moonbrook-mine", level: 20 },
    party: { size: 5, members: PARTY_MEMBERS.map((m) => ({ ...m })) },
    ...over,
  });
}
