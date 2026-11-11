/**
 * A fan-out run directory (`<run>/sessions/<Character>/`, one session record
 * per character, no `session/`), written with the stack's own `SessionWriter`
 * from readings, for the tests of what the readers make of one. The
 * trajectory is the frozen v1 run's, renamed; the roster holds a token no
 * reader may ever serve (`FANOUT_ROSTER_TOKEN`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionWriter, type SessionCharacter } from "@wrathbench/mcp/record";
import { recordDrain, traceOfReading, type TraceReading } from "./v1-session";
import { V1P1_RUN, V1P1_SRC } from "./v1p1";

export const FANOUT_RUN = "fanout-probe";
/** In `roster.json` only: a body that carries it read a file nothing may read. */
export const FANOUT_ROSTER_TOKEN = "fanout-roster-token-0f0f0f0f0f0f";

export interface FanoutCharacter {
  name: string;
  guid: string;
  readings: TraceReading[];
}

export const FANOUT_CHARACTERS: FanoutCharacter[] = [
  { name: "Bravo", guid: "902", readings: [{ ts: 1762000300000, level: 3, xp: 120, map: 0, x: -9450, y: 70, z: 57, money: 40 }] },
  { name: "Alfa", guid: "901", readings: [{ ts: 1762000200000, level: 5, xp: 900, map: 0, x: -9460, y: 60, z: 57, money: 250 }] },
];

/**
 * Write a fan-out run under `runsDir/<runId>/`. `closed` closes every
 * character's session, as a finished run's are.
 */
export async function writeFanoutRun(runsDir: string, o: { runId?: string; characters?: FanoutCharacter[]; closed?: boolean } = {}): Promise<string> {
  const runId = o.runId ?? FANOUT_RUN;
  const characters = o.characters ?? FANOUT_CHARACTERS;
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  const meta = JSON.parse(readFileSync(join(V1P1_SRC, "meta.json"), "utf8")) as { runId: string; config: Record<string, unknown> };
  meta.runId = runId;
  meta.config = {
    ...meta.config,
    runId,
    character: characters[0]?.name,
    account: "FANA",
    fanout: { characters: characters.length, accounts: characters.map((_, i) => `FAN${String.fromCharCode(65 + i)}`) },
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  writeFileSync(join(dir, "trajectory.jsonl"), readFileSync(join(V1P1_SRC, "trajectory.jsonl"), "utf8").replaceAll(V1P1_RUN, runId));
  writeFileSync(join(dir, "roster.json"), JSON.stringify({ characters: characters.map((c) => ({ character: c.name, token: FANOUT_ROSTER_TOKEN })) }), { mode: 0o600 });
  for (const [i, c] of characters.entries()) {
    const clock = { now: c.readings[0]?.ts ?? Date.now() };
    const character: SessionCharacter = { guid: c.guid, name: c.name, race: 1, class: 1 };
    const writer = new SessionWriter({ dir: join(dir, "sessions", c.name), id: `fa0f0f0f0f0f0f0${i}`, stack: { version: "0.0.0-test" }, now: () => clock.now, log: () => {} });
    writer.open();
    for (const r of c.readings) {
      clock.now = r.ts;
      const t = traceOfReading(r);
      writer.ingest(recordDrain({ trace: t.trace, dict: t.dict, character }));
    }
    if (o.closed === true) await writer.close();
  }
  return dir;
}
