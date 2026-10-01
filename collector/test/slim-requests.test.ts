/**
 * The collector over one fixed-loop run written three ways: as the slim
 * writer wrote it, as the pre-slim writer would have, and switching from one
 * to the other at a resume (`runner/test/fixtures/slim-run.ts`). The derived
 * rows must agree, because the run is the same run; only the `messages`
 * column may differ, and on a slim request it is empty rather than partial.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Collector } from "../src/collector";
import { readConfig } from "../src/config";
import { OffsetStore } from "../src/offsets";
import { memorySink } from "../src/sink";
import { SLIM_RUN_ID, legacyVariant, slimRun } from "../../runner/test/fixtures/slim-run";
import { tempDirs } from "../../runner/test/fixtures/temp-dirs";

const tempDir = tempDirs();

type Rows = Record<string, Record<string, unknown>[]>;
const rows: Record<"slim" | "legacy" | "mixed", Rows> = { slim: {}, legacy: {}, mixed: {} };

async function collect(runsDir: string): Promise<Rows> {
  const sink = memorySink();
  const cfg = readConfig({ runsDir, dataDir: runsDir, stateDb: ":memory:" });
  await new Collector({ cfg, sink, offsets: new OffsetStore(":memory:"), log: () => {} }).pass();
  return Object.fromEntries([...sink.tables.entries()].map(([k, v]) => [k, v as Record<string, unknown>[]]));
}

beforeAll(async () => {
  const runsDirs = { slim: tempDir("collector-slim-"), legacy: tempDir("collector-legacy-"), mixed: tempDir("collector-mixed-") };
  for (const d of Object.values(runsDirs)) mkdirSync(join(d, SLIM_RUN_ID));
  await slimRun(join(runsDirs.slim, SLIM_RUN_ID));
  legacyVariant(join(runsDirs.slim, SLIM_RUN_ID), join(runsDirs.legacy, SLIM_RUN_ID), () => true);
  legacyVariant(join(runsDirs.slim, SLIM_RUN_ID), join(runsDirs.mixed, SLIM_RUN_ID), (segment) => segment === 1);
  rows.slim = await collect(runsDirs.slim);
  rows.legacy = await collect(runsDirs.legacy);
  rows.mixed = await collect(runsDirs.mixed);
});

/** A turns row without the columns that carry the line itself. */
function typed(r: Record<string, unknown>): Record<string, unknown> {
  const { messages: _m, raw: _r, ingested_at: _i, ...rest } = r;
  return rest;
}

describe("the collector reads old, new and mixed alike", () => {
  test("turns rows agree on every typed column", () => {
    const legacy = rows.legacy["turns"]!.map(typed);
    expect(legacy.filter((r) => r["kind"] === "request").length).toBeGreaterThan(0);
    expect(rows.slim["turns"]!.map(typed)).toEqual(legacy);
    expect(rows.mixed["turns"]!.map(typed)).toEqual(legacy);
  });

  test("a slim request lands with an empty messages column and its whole line in raw", () => {
    const requests = rows.mixed["turns"]!.filter((r) => r["kind"] === "request");
    const full = requests.filter((r) => r["messages"] !== "");
    const slim = requests.filter((r) => r["messages"] === "");
    expect(full.length).toBeGreaterThan(0);
    expect(slim.length).toBeGreaterThan(0);
    for (const r of slim) expect(JSON.parse(String(r["raw"]))).toMatchObject({ t: "request", slim: 1 });
    for (const r of full) expect(Array.isArray(JSON.parse(String(r["messages"])))).toBe(true);
  });

  test("the per-run derivations are identical", () => {
    const totals = (r: Rows): unknown => {
      const [row] = r["run_totals"]!;
      return { totals: JSON.parse(String(row?.["totals_json"])), fact: String(row?.["fact_json"]) };
    };
    const legacy = totals(rows.legacy) as { totals: { tokens: { promptTokens: number } } };
    expect(legacy.totals.tokens.promptTokens).toBeGreaterThan(0);
    expect(totals(rows.slim)).toEqual(legacy);
    expect(totals(rows.mixed)).toEqual(legacy);
  });
});
