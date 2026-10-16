/**
 * The flight producer: takeoffs and landings latched in the sandbox child off
 * the events that flip the taxi flag, drained by the loop's state sample and
 * written as `taxi` / `taxi_landed` milestones with the flip's own position
 * and area.
 *
 * Two halves, both fixture-based, in the shape of `death.test.ts`. The child
 * half runs the real sandbox process against a fake event stream — frames
 * hand-written from module/PROTOCOL.md's tables, positions invented, nothing
 * captured from a running game (CLAUDE.md). The loop half feeds drained
 * signals through a fake sandbox and reads the trajectory.
 *
 * The case that earned this: a `taxi_landed` written by a 60s sample placed a
 * landing in the Deeprun Tram the character had walked into since, and two
 * legs of a chain inside one sample merged into one pair.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "../src/scratchpad";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

const hosts: SandboxHost[] = [];

function makeHost(): SandboxHost {
  const dir = tempDir("wrathbench-flight-");
  const host = new SandboxHost({
    moduleUrl: "http://worldserver:8086",
    token: "test-token",
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 5_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
});

/**
 * Enter the world as guid "7" at an invented take-off point and expose the
 * frames a flight is made of: `SMSG_ACTIVATETAXIREPLY` 0x1AE, the flag on
 * `SMSG_UPDATE_OBJECT` 0x0A9 (`UNIT_FLAG_TAXI_FLIGHT` = 0x00100000), the
 * flight's own `SMSG_MONSTER_MOVE` 0x0DD, `WB_AREA` 0xFF07 for the area the
 * flight crosses into, and the module's `WB_SELF_MOVE` 0xFF09 drop. Area
 * names are left empty: the ids are all this reads.
 */
const PRELUDE = `
globalThis.seq = 1;
globalThis.feed = (opcode, opcodeId, data) => {
  events.ingest(JSON.stringify({ seq: seq++, opcode, opcodeId, ts: 1000 + seq, data }));
};
globalThis.unitFlags = (flags) =>
  feed("SMSG_UPDATE_OBJECT", 0xa9, { blocks: 1, objects: [{ update: "values", guid: "7", fields: { unitFlags: flags } }] });
globalThis.taxiReply = (reply) => feed("SMSG_ACTIVATETAXIREPLY", 0x1ae, { reply, ok: reply === 0 });
globalThis.spline = (from, to, durationMs) => feed("SMSG_MONSTER_MOVE", 0xdd, { guid: "7", pos: from, destination: to, durationMs });
globalThis.area = (zoneId, areaId) => feed("WB_AREA", 0xff07, { mapId: 0, zoneId, zoneName: "", areaId, areaName: "" });
globalThis.drop = (pos, fromZ) => feed("WB_SELF_MOVE", 0xff09, { opcode: "MSG_MOVE_FALL_LAND", cause: "taxi_landing", pos, fromZ });
feed("WB_SESSION_STATE", 0xff03, {
  character: "Fenwick", guid: "7", inWorld: true,
  map: 0, x: -4821, y: -1155, z: 502, o: 1.7, level: 10,
  zoneId: 1537, zoneName: "", areaId: 1537, areaName: "",
});
unitFlags(0x8);
`;

describe("sandbox child: flights latched from the events", () => {
  test("a takeoff and a landing carry the flip's own position and area; two legs in one drain are two pairs", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE)).ok).toBe(true);
    expect(await host.flightSignals()).toEqual([]);

    await host.evalSnippet(`
      // Leg one: accepted, the spline, the flag on. Mid-flight the area
      // changes under the character; the landing is the flag off, then the
      // module's drop to the ground.
      taxiReply(0);
      spline({ x: -4821, y: -1155, z: 502 }, { x: -5421, y: -2930, z: 351.5 }, 120000);
      unitFlags(0x100008);
      area(38, 38);
      unitFlags(0x8);
      drop({ x: -5421, y: -2930, z: 347.2, o: 1.7 }, 351.5);
      // Leg two, inside the same drain window, lands somewhere else again.
      taxiReply(0);
      spline({ x: -5421, y: -2930, z: 347.2 }, { x: -4821, y: -1155, z: 506.5 }, 120000);
      unitFlags(0x100008);
      area(1537, 1537);
      unitFlags(0x8);
      // Walking on afterwards changes the sample's area, not the landing's.
      area(1537, 2257);
      "fed";
    `);

    const signals = await host.flightSignals();
    expect(signals.map((s) => s.kind)).toEqual(["taxi", "taxi_landed", "taxi", "taxi_landed"]);
    const [takeoff, landing, , second] = signals;
    expect(takeoff!.area).toBe(1537);
    expect(takeoff!.position).toEqual({ map: 0, x: -4821, y: -1155, z: 502 });
    // The landing as the flip saw it: the spline's end, in the landing's area —
    // not the tram the character walked into afterwards.
    expect(landing!.area).toBe(38);
    expect(landing!.position).toEqual({ map: 0, x: -5421, y: -2930, z: 351.5 });
    expect(second!.area).toBe(1537);
    expect(second!.ts).toBeGreaterThan(landing!.ts);
    // Drained once: a second drain is empty.
    expect(await host.flightSignals()).toEqual([]);
  });

  test("a flag turning on without an accepted reply is not a takeoff, and a process that opens mid-flight sees no takeoff", async () => {
    const host = makeHost();
    expect((await host.evalSnippet(PRELUDE.replace("unitFlags(0x8);", "unitFlags(0x100008);"))).ok).toBe(true);
    await host.evalSnippet(`
      // Seeded flying: the landing is an observation, the takeoff was not seen.
      unitFlags(0x8);
      // On again with no accepted reply behind it: nothing said a flight began.
      unitFlags(0x100008);
      unitFlags(0x8);
      "fed";
    `);
    expect((await host.flightSignals()).map((s) => s.kind)).toEqual(["taxi_landed", "taxi_landed"]);
  });
});
