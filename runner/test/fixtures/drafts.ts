/**
 * Shared fixtures for the draft suites (`drafts.test.ts`, the store and the
 * pure layer; `viewer-config-drafts.test.ts`, the routes). The catalogue is
 * `openrouter-models.json` beside this file, served by an injected fetcher:
 * nothing in either suite reaches the network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFleet } from "../../../infra/run-fleet-config";
import { ConfigStore, readFleetConfig } from "../../src/config-store";
import type { DraftRecord } from "../../viewer/drafts";

export const CATALOGUE_TEXT = readFileSync(join(import.meta.dir, "openrouter-models.json"), "utf8");

/** In the roster already, so never proposed. */
export const ROSTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

export const CONFIG = {
  _notes: ["fixture"],
  accounts: { pool: ["RUNNER"] },
  roster: {
    nemo: { model: ROSTER_MODEL, tier: "t1" },
    son: { model: "sonnet", driver: "claude-code", tier: "t1" },
  },
  policy: { maxConcurrent: { openrouter: 1 } },
  queue: [],
};

/** A pending draft as a fetch of the fixture writes it. */
export const PENDING: DraftRecord = {
  model: "z-ai/glm-6",
  status: "draft",
  name: "Z.AI: GLM 6",
  created: 1_790_000_000_000,
  price: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.6 },
  firstSeen: 1,
};

/** A seeded store in a directory from the calling file's `tempDirs()`. */
export function seededStore(tempDir: (prefix: string) => string, config: unknown = CONFIG): string {
  const db = join(tempDir("drafts-"), "config.sqlite");
  const store = new ConfigStore(db);
  store.seed(config, { actor: "fixture" });
  store.close();
  return db;
}

/** A fetcher that serves `text` and records every URL it was asked for. */
export function catalogueFetch(text = CATALOGUE_TEXT): { fetch: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: f, calls };
}

/** What the supervisor reads from the store, parsed. */
export function fleetOf(db: string): ReturnType<typeof parseFleet> {
  const read = readFleetConfig(db);
  if (read.status !== "ok") throw new Error(`store ${read.status}`);
  return parseFleet(JSON.parse(read.text));
}

/** What a write to the config would move: the version, the history, the rendered text. */
export function storeFacts(db: string): { version: number; audit: number; text: string } {
  const store = new ConfigStore(db, { readonly: true });
  try {
    const read = readFleetConfig(db);
    return { version: store.version(), audit: store.audit(1000).length, text: read.status === "ok" ? read.text : read.status };
  } finally {
    store.close();
  }
}
