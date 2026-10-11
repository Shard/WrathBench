/**
 * Published campaign definitions in the config store: written once, only by
 * a publish, read by every reader through the same document, and out of
 * reach of every generic write path — the CLI's set/patch/delete, the
 * viewer's /config routes and a seed, which accepts a definition only exactly
 * as it is already stored.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApi } from "../viewer/api";
import { readFleetRoster } from "../viewer/models";
import { ConfigRejected, ConfigStore, readFleetConfig } from "../src/config-store";
import { parseFleet } from "../../infra/run-fleet-config";
import { definition, publication } from "./fixtures/campaigns";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const CONFIG = {
  accounts: { pool: ["RUNNER"] },
  roster: { glm: { tier: "t1", model: "z-ai/glm-5.2:free" } },
  queue: [],
};

const def = definition({ id: "probe" });

function store(): { s: ConfigStore; path: string } {
  const path = join(tempDir("wb-campaign-store-"), "config.sqlite");
  const s = new ConfigStore(path);
  s.seed(CONFIG, { actor: "fixture" });
  return { s, path };
}

describe("publishing", () => {
  test("writes campaign-defs/<id>@<version>, audited, and every reader sees it", () => {
    const { s, path } = store();
    expect(s.publishDefinition(publication(def), { actor: "op", note: "first" })).toEqual({ key: "campaign-defs/probe@1", status: "published" });
    expect(s.audit(1)[0]).toMatchObject({ key: "campaign-defs/probe@1", actor: "op", note: "first", before: null });
    s.put("campaigns/probe", { version: 1, assignments: [{ model: "glm" }] });
    s.close();
    const read = readFleetConfig(path);
    if (read.status !== "ok") throw new Error(read.status);
    const config = parseFleet(JSON.parse(read.text));
    expect(config.campaignDefs.map((d) => d.ref)).toEqual(["probe@1"]);
    expect(config.campaigns.map((c) => `${c.name}@${c.version}`)).toEqual(["probe@1"]);
    const roster = readFleetRoster(path, null);
    expect(roster.campaignDefs.map((d) => d.ref)).toEqual(["probe@1"]);
    expect(roster.campaigns.map((c) => c.name)).toEqual(["probe"]);
  });

  test("is write-once: the same definition again is a no-op, a changed one is refused", () => {
    const { s } = store();
    s.publishDefinition(publication(def));
    const before = s.audit(100).length;
    expect(s.publishDefinition(publication(def, 2)).status).toBe("unchanged");
    expect(s.audit(100).length).toBe(before);
    expect(() => s.publishDefinition(publication(definition({ id: "probe", question: "changed" })))).toThrow(/already published as/);
    s.close();
  });

  test("refuses a document whose hash is not its definition's, or that is not a definition at all", () => {
    const { s } = store();
    expect(() => s.publishDefinition({ ...publication(def), hash: "sha256:0000000000000000" })).toThrow(ConfigRejected);
    expect(() => s.publishDefinition({ definition: { id: "x" } })).toThrow(ConfigRejected);
    s.close();
  });
});

describe("the generic write paths", () => {
  test("set, patch and delete refuse the prefix", () => {
    const { s } = store();
    s.publishDefinition(publication(def));
    expect(() => s.put("campaign-defs/probe@1", publication(definition({ id: "probe", question: "x" })))).toThrow(/written once/);
    expect(() => s.patch("campaign-defs/probe@1", { hash: "sha256:1111111111111111" })).toThrow(/written once/);
    expect(() => s.put("campaign-defs/probe@1", undefined)).toThrow(/written once/);
    expect(() => s.put("campaign-defs/new@1", publication(definition({ id: "new" })))).toThrow(/written once/);
    expect(() => s.put("campaign-defs", {})).toThrow(/written once/);
    expect(s.get("campaign-defs/probe@1")).toEqual(publication(def));
    s.close();
  });

  test("the viewer's /config routes refuse it with the store's own sentence", async () => {
    const { s, path } = store();
    s.publishDefinition(publication(def));
    s.close();
    const root = tempDir("wb-campaign-api-");
    const handle = createApi({ runsDir: join(root, "runs"), tilesDir: join(root, "tiles"), configDbPath: path });
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const body = method === "DELETE" ? {} : { body: JSON.stringify({ hash: "x" }) };
      // The write guard stands in front of these rows as of every other: a
      // write that is not JSON is refused before the store is asked.
      const bare = await handle(new Request("http://x/api/config/campaign-defs/probe@1", { method, ...body }));
      expect([method, bare!.status]).toEqual([method, 415]);
      const res = await handle(
        new Request("http://x/api/config/campaign-defs/probe@1", { method, headers: { "content-type": "application/json" }, ...body }),
      );
      expect([method, res!.status]).toEqual([method, 400]);
      expect(((await res!.json()) as { error: string }).error).toContain("written once");
    }
  });

  test("a row that does not read is never written; one already stored blocks no other edit, and reads as its own refusal", () => {
    const { s, path } = store();
    expect(() => s.put("campaigns/probe", { enabled: true, models: ["glm"] })).toThrow(/campaign probe/);
    expect(() => s.patch("campaigns/probe", { cells: [] })).toThrow(/campaign probe/);
    expect(() => s.put("campaigns/bad id", { version: 1 })).toThrow(ConfigRejected);
    expect(() => s.seed({ ...CONFIG, campaigns: { probe: { version: 1, objective: "x" } } }, { force: true })).toThrow(/campaign probe/);
    // A row written past the store (an older image's shape): the next edit
    // elsewhere still goes through, and the reader refuses that row alone.
    s.db.run("INSERT INTO config (key, ord, json, updated_at) VALUES (?, 0, ?, 0)", ["campaigns/legacy", JSON.stringify({ enabled: true, models: ["glm"] })]);
    s.publishDefinition(publication(def));
    s.put("campaigns/probe", { version: 1, assignments: [{ model: "glm" }] });
    s.patch("roster/glm", { tier: "t2" });
    s.close();
    const roster = readFleetRoster(path, null);
    expect(roster.campaigns.map((c) => c.name)).toEqual(["probe"]);
    expect(roster.campaignRefusals.map((r) => r.key)).toEqual(["campaigns/legacy"]);
    expect(roster.models.find((m) => m.name === "glm")?.tier).toBe("t2");
  });

  test("a row naming an unpublished version is accepted by the store and refused by name on read", () => {
    const { s, path } = store();
    s.put("campaigns/later", { version: 1, assignments: [{ model: "glm" }] });
    s.close();
    const roster = readFleetRoster(path, null);
    expect(roster.campaigns).toEqual([]);
    expect(roster.campaignRefusals).toEqual([{ key: "campaigns/later", campaign: "later", reason: expect.stringContaining("not published") }]);
  });
});

describe("a reseed", () => {
  test("keeps published definitions, and accepts one in the document only exactly as it is stored", () => {
    const { s } = store();
    s.publishDefinition(publication(def));
    s.seed({ ...CONFIG, roster: { glm: { tier: "t2", model: "z-ai/glm-5.2:free" } } }, { force: true });
    expect(s.get("campaign-defs/probe@1")).toEqual(publication(def));
    // An export carries them back unchanged: accepted, and nothing is written for them.
    const before = s.audit(1000).filter((a) => a.key.startsWith("campaign-defs/")).length;
    s.seed(s.render(), { force: true });
    expect(s.get("campaign-defs/probe@1")).toEqual(publication(def));
    expect(s.audit(1000).filter((a) => a.key.startsWith("campaign-defs/")).length).toBe(before);
    // A document that would change one: refused, and nothing is replaced.
    const changed = { ...s.render(), "campaign-defs": { "probe@1": publication(definition({ id: "probe", question: "changed" })) } };
    expect(() => s.seed(changed, { force: true })).toThrow(/never changed/);
    // Even a different publishedAt is a different row: identical means identical.
    const restamped = { ...s.render(), "campaign-defs": { "probe@1": publication(def, 1) } };
    expect(() => s.seed(restamped, { force: true })).toThrow(/never changed/);
    expect((s.get("roster/glm") as { tier: string }).tier).toBe("t2");
    s.close();
  });

  test("never publishes: a definition the store does not hold is refused, valid or not, and the store is untouched", () => {
    const fresh = new ConfigStore(join(tempDir("wb-campaign-reseed-"), "config.sqlite"));
    expect(() => fresh.seed({ ...CONFIG, "campaign-defs": { "probe@1": publication(def) } })).toThrow(/does not publish campaign definitions.*campaign-publish/);
    expect(() => fresh.seed({ ...CONFIG, "campaign-defs": { "probe@1": { ...publication(def), hash: "sha256:0000000000000000" } } })).toThrow(ConfigRejected);
    expect(fresh.isEmpty()).toBe(true);
    // The same on a seeded store under --force: a second definition rides in nowhere.
    const { s } = store();
    s.publishDefinition(publication(def));
    const other = definition({ id: "other" });
    expect(() => s.seed({ ...s.render(), "campaign-defs": { ...defsOf(s), "other@1": publication(other) } }, { force: true })).toThrow(/does not publish/);
    expect(s.get("campaign-defs/other@1")).toBeUndefined();
    // Published, the same document seeds.
    s.publishDefinition(publication(other));
    s.seed({ ...s.render() }, { force: true });
    expect(s.get("campaign-defs/other@1")).toEqual(publication(other));
    fresh.close();
    s.close();
  });
});

/** The `campaign-defs` block a store renders. */
function defsOf(s: ConfigStore): Record<string, unknown> {
  return (s.render()["campaign-defs"] ?? {}) as Record<string, unknown>;
}
