/**
 * The death records: the transitions the stack recorded off the events that
 * carry them (`@wrathbench/mcp/record`), in the run's session record as
 * `death` / `release` / `resurrect` rows, and what the scorer reads off them
 * (`RunTotalsScanner`).
 *
 * The watcher itself, frame by frame, is the stack's and is tested there
 * (`wrath-mcp/mcp/test/record-watchers.test.ts`). Here: that a real child's
 * death reaches the run's own record through the runner's host, and that the
 * scorer counts it. Frames are hand-written from wrath-mcp/module/PROTOCOL.md's
 * own tables; positions are invented and nothing here is captured from a
 * running game (CLAUDE.md).
 *
 * The shape of the sequence is the one run
 * `fleet-sonnet-low-freeplay-sonnet-low-20260827-a2` produced three times and
 * the 0.5 loop's sampled window read caught none of: own health to zero,
 * `repop()`, the graveyard, the Spirit Healer, health back — the whole window
 * inside 30s, against a 60s sample.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionReader, type EventRow } from "@wrathbench/mcp/record";
import { SandboxHost } from "../src/sandbox/host";
import { openSessionRecord } from "../src/session-record";
import { Scratchpad } from "@wrathbench/mcp";
import { scanRunTotals } from "../viewer/tail";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const hosts: SandboxHost[] = [];

/** A real runner host; with `record`, the run's session record as run.ts opens it. */
let runDir = "";
function makeHost(o: { record?: boolean } = {}): SandboxHost {
  const runsDir = tempDir("wrathbench-death-");
  runDir = join(runsDir, "run-death");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(runsDir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
    ...(o.record === true ? { session: openSessionRecord({ runDir, runsDir, token: "test-token", scrub: (t) => t }) } : {}),
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * Enter the world as guid "7" and expose the frames a death is made of.
 * Opcode ids are PROTOCOL.md's: `WB_SESSION_STATE` 0xFF03 (which carries the
 * position and the zone/area pair a reattaching client is given),
 * `SMSG_UPDATE_OBJECT` 0x0A9, `SMSG_DEATH_RELEASE_LOC` 0x378,
 * `SMSG_CORPSE_RECLAIM_DELAY` 0x269. Zone and area names are left empty: the
 * ids are all this reads, and game text does not belong in the repo.
 */
const PRELUDE = `
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
globalThis.selfFields = (fields) =>
  feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields }] });
globalThis.releaseLoc = (map, x, y, z) => feed("SMSG_DEATH_RELEASE_LOC", 0x378, { map, x, y, z });
globalThis.reclaimDelay = (delayMs) => feed("SMSG_CORPSE_RECLAIM_DELAY", 0x269, { delayMs });
feed("WB_SESSION_STATE", 0xff03, {
  character: "Fenwick", guid: "7", inWorld: true,
  map: 0, x: -6572, y: 405, z: 387, o: 1.7, level: 7,
  zoneId: 1, zoneName: "", areaId: 132, areaName: "",
});
selfFields({ health: 186, maxHealth: 186, playerFlags: 0 });
`;

/** One whole window: death, repop to the graveyard, the Spirit Healer. */
const WINDOW = `
  selfFields({ health: 0 });
  reclaimDelay(30000);
  releaseLoc(0, -6164, 336, 399);
  selfFields({ playerFlags: 0x10, health: 1 });
  releaseLoc(-1, 0, 0, 0);
  selfFields({ playerFlags: 0, health: 132 });
  "fed";
`;

/** The death-family rows the run's session record holds, after the host's drain. */
async function deathRows(host: SandboxHost): Promise<EventRow[]> {
  await host.recordDrain();
  return new SessionReader(join(runDir, "session")).rows("events").filter((r) => r.kind === "death" || r.kind === "release" || r.kind === "resurrect");
}

describe("the run's session record holds the death the child saw, and the scorer counts it", () => {
  test("a death, release and resurrect come back from the record, in order, each with its event's stamp and seq", async () => {
    const host = makeHost({ record: true });
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    expect(await deathRows(host)).toEqual([]);
    expect((await host.evalSnippet(WINDOW)).ok).toBe(true);
    const rows = await deathRows(host);
    expect(rows.map((s) => s.kind)).toEqual(["death", "release", "resurrect"]);
    expect(rows[0]).toMatchObject({ position: { map: 0, x: -6572, y: 405, z: 387, source: "death_spot" }, zone: 1, area: 132, released: false });
    expect(rows[1]).toMatchObject({ graveyard: { map: 0, x: -6164, y: 336, z: 399 } });
    expect(rows[0]!.ts).toBeLessThan(rows[1]!.ts);
    expect(rows[1]!.ts).toBeLessThan(rows[2]!.ts);
    expect(rows.every((s) => (s.seq ?? 0) > 0)).toBe(true);
    // The scorer reads the same rows: one death, one release, one resurrect.
    writeFileSync(join(runDir, "trajectory.jsonl"), "");
    const deaths = (await scanRunTotals(join(runDir, "trajectory.jsonl"))).deaths!;
    expect([deaths.deaths, deaths.releases, deaths.resurrects]).toEqual([1, 1, 1]);
    expect(deaths.first).toMatchObject({ zone: 1, area: 132, position: { map: 0, x: -6572, y: 405, z: 387, source: "death_spot" } });
  });

  test("a host that keeps no record has no kills to hand the loop, and says so by throwing", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    await expect(host.partySignals()).rejects.toThrow("keeps no session record");
  });
});
