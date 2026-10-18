/**
 * The steep re-plan, reproduced: eight `move_to`s a freeplay character made
 * in Ashenvale and the Badlands, each from the point it stood on, with the
 * verdict the module served it then beside the verdict served now.
 *
 * Six of the eight were `drop` refusals at a single 4y step of 51-58 degrees
 * (the guard refuses a segment over 2.0y and steeper than 1.2x its 2D
 * length, about 50 degrees; the mesh is built to walk 60). The module now
 * re-plans around such a band before refusing (module/PROTOCOL.md, `drop`),
 * so some of those should arrive. The other two are `target_off_mesh`
 * controls: the re-plan never runs on them, and they must stay as they were.
 *
 * Per start (one fixture scenario each, infra/fixtures/scenarios.ts
 * `steep-*`, level 80 so nothing interrupts a walk):
 *   1. apply the scenario to the persistent character, log in, and check it
 *      stands where the scenario put it;
 *   2. the control first when the start has one (it moves nothing), then the
 *      refusal, both as raw `move_to`s: no fall estimate stands in, so a
 *      step down answers `drop` as the module decided it (the SDK's
 *      `moveTo` would force it on either build);
 *   3. P5, a step down the old module refused and walked with `force`: when
 *      it still answers `drop`, it is re-issued with `force` as then;
 *   4. logout.
 * When the module's audit directory is readable from here (the quickstart's
 * runner mounts all of data/; the cluster's runner pod does not mount the
 * worldserver's logs), each refusal is also matched to its
 * `move_replan_steep` record, and a re-planned route is checked against the
 * guard from its `move_path` polyline.
 *
 * Exit 1 when a start could not be run (the fixture did not land, the
 * session failed, a verdict never came), when a control is no longer
 * `target_off_mesh`, or, with the audit readable, when a `drop` has no
 * re-plan record (the running module predates the re-plan), a re-planned
 * route trips the guard, or a re-planned walk did not arrive. How many
 * refusals now arrive is the measurement, not the gate: it is reported.
 *
 * An operator smoke, not a deploy smoke: it runs on PROBE (never a gate
 * account), writes six fixture placements, waits out the core's ~60s
 * logout hold between them (several minutes in all), and is diagnostic.
 *
 *   bun wb smoke steep-replan
 *   bun wb --local smoke steep-replan   # the quickstart, audit readable
 *
 * `SMOKE_REPROS=P1,P5` runs a subset; `SMOKE_CHARACTER` names the fixture
 * character; MODULE_ACCOUNT (default PROBE) and WRATHBENCH_AUDIT_DIR are the
 * runner's environment, which `bun wb` does not carry:
 * `kubectl -n wrathbench exec deploy/wrathbench-runner -- env
 * SMOKE_REPROS=P1 bun infra/smoke/steep-replan.ts`.
 *
 * Coordinates are the refused moves' own (harness tooling, not an agent run;
 * the observation contract does not apply to this script). Audit file names
 * are session tokens and are never printed.
 */

import { readdir } from "node:fs/promises";
import { connect, type MovePoint, type MoveResultData, type WrathClient } from "../../sdk/src/index";
import { SCENARIOS, type ScenarioName } from "../fixtures/scenarios";
import { accountFixtureName, applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
// One persistent character for every start: PROBE holds many smoke
// characters already, and the realm caps an account at ten.
const CHARACTER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Sr", ACCOUNT);
const RUN = crypto.randomUUID();
const AUDIT_DIR = process.env.WRATHBENCH_AUDIT_DIR ?? "/wrathbench/data/logs/wrathbench";
// A re-planned route may run to about 590y (module/src/WbManager.cpp
// REPLAN_MAX_POINTS): 85s at the 7y/s a character without a mount runs.
const MOVE_TIMEOUT_MS = 120_000;
// The guard, as the module states it (PROTOCOL.md `drop`).
const DROP_MIN_DZ = 2.0;
const DROP_SLOPE = 1.2;

const started = Date.now();
const log = (m: string): void => console.log(`[steep +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);

class StartFailed extends Error {}
function fail(m: string): never {
  throw new StartFailed(m);
}

type Vec = { x: number; y: number; z: number };
const fmt = (p: Vec): string => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
const signed = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;

interface Repro {
  id: string;
  target: MovePoint;
  /** The verdict the module served this move before the re-plan, from its own audit rows. */
  before: string;
  /** A `target_off_mesh` control: the re-plan never runs on it. */
  control?: true;
  /** Re-issue with `force` when the answer is still a step down, as the old module's caller did. */
  forceStepDown?: true;
}

interface Start {
  scenario: ScenarioName;
  repros: Repro[];
}

const STARTS: Start[] = [
  {
    scenario: "steep-ashenvale-lowland",
    repros: [
      { id: "P4", target: { x: 3200, y: -100, z: 80 }, before: "target_off_mesh, nearest (3190.1, -106.7, 101.8)", control: true },
      { id: "P1", target: { x: 3190.13, y: -106.667, z: 101.774 }, before: "drop, climb +5.0" },
    ],
  },
  { scenario: "steep-ashenvale-climb", repros: [{ id: "P2", target: { x: 3087.73, y: 71.2, z: 69.6964 }, before: "drop, climb +6.2" }] },
  { scenario: "steep-ashenvale-band", repros: [{ id: "P3", target: { x: 3008, y: 128, z: 54.7552 }, before: "drop, climb +4.9" }] },
  {
    scenario: "steep-badlands-plateau",
    repros: [
      {
        id: "P5",
        target: { x: -5897.6, y: -3356.8, z: 310.366 },
        before: "drop, step down -5.9; arrived with force",
        forceStepDown: true,
      },
    ],
  },
  { scenario: "steep-badlands-lip", repros: [{ id: "P6", target: { x: -6140, y: -3370, z: 293 }, before: "drop, climb +5.2" }] },
  {
    scenario: "steep-badlands-basin",
    repros: [
      { id: "P8", target: { x: -6250, y: -3300, z: 245 }, before: "target_off_mesh, nearest (-6267.2, -3316.5, 301.6)", control: true },
      { id: "P7", target: { x: -6121.87, y: -3482.93, z: 293.581 }, before: "drop, climb +5.8" },
    ],
  },
];

/** One served verdict. */
interface Answer {
  moveId: number;
  forced: boolean;
  data: MoveResultData;
}

interface Outcome {
  repro: Repro;
  map: number;
  start: Vec;
  token: string;
  answer: Answer;
  forced?: Answer;
}

function describe(a: Answer): string {
  const d = a.data;
  switch (d.status) {
    case "arrived":
      return `arrived at ${fmt(d.pos)}${d.meshZ !== undefined ? ` (meshZ ${d.meshZ.toFixed(1)})` : ""}`;
    case "drop": {
      const dz = d.dz ?? 0;
      const at = d.reachedPos ? ` at ${fmt(d.reachedPos)}` : "";
      return `drop, ${dz > 0 ? "climb" : "step down"} ${signed(dz)}${at}${d.surfaceZ !== undefined ? `, foot under the surface ${d.surfaceZ.toFixed(1)}` : ""}`;
    }
    case "target_off_mesh":
      return `target_off_mesh, nearest ${d.nearest ? fmt(d.nearest) : d.nearest === null ? "none within 20y" : "not served"}`;
    case "path_incomplete":
      return `path_incomplete${d.reachedPos ? `, mesh reaches ${fmt(d.reachedPos)}` : ""}`;
    default:
      return `${d.status} at ${fmt(d.pos)}`;
  }
}

async function createSessionWithBackoff(client: WrathClient): Promise<void> {
  // Another probe may hold the single PROBE session; wait it out (up to 20min).
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    try {
      await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
      return;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (/char_create_failed_code_53/.test(msg)) {
        fail(`${ACCOUNT} is at the realm's ten-character cap, so ${CHARACTER} cannot be created; delete a spare character or set SMOKE_CHARACTER to one that exists`);
      }
      if (!/account_in_use|token_in_use|in use/i.test(msg) || Date.now() > deadline) throw e;
      log(`  account busy (${msg.slice(0, 80)}); retrying in 60s`);
      await Bun.sleep(60_000);
    }
  }
}

const fixtureCtx: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: `smoke-steep-${RUN}`,
  log,
  fail,
  createAndLogout: async () => {
    const client = await connect({ baseUrl: BASE, token: `smoke-steep-${RUN}-create`, secret: MODULE_SECRET });
    try {
      await createSessionWithBackoff(client);
      await client.logout();
    } finally {
      client.close();
    }
  },
};

async function selfPosition(client: WrathClient): Promise<{ map: number } & Vec> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const p = client.state.self.position?.value;
    if (p !== undefined) return p;
    if (Date.now() > deadline) fail("no self position observed after login");
    await Bun.sleep(100);
  }
}

/** A raw `move_to` and its verdict: no fall estimate, `force` only when asked. */
async function probe(client: WrathClient, target: MovePoint, force: boolean): Promise<Answer> {
  const ack = await client.moveToAsync(target, { force });
  const ev = await client.events.waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && (e.data as { moveId?: number } | undefined)?.moveId === ack.moveId,
    { timeout: MOVE_TIMEOUT_MS, description: `WB_MOVE_RESULT for moveId ${ack.moveId}` },
  );
  return { moveId: ack.moveId, forced: force, data: ev.data as MoveResultData };
}

async function runStart(start: Start, n: number, outcomes: Outcome[]): Promise<void> {
  const want = SCENARIOS[start.scenario].position;
  log(`${start.scenario}: map ${want.map} ${fmt(want)} — ${start.repros.map((r) => r.id).join(", ")}`);
  await applyScenario(fixtureCtx, start.scenario);
  const token = `smoke-steep-${RUN}-${n}`;
  const client = await connect({ baseUrl: BASE, token, secret: MODULE_SECRET });
  try {
    await createSessionWithBackoff(client);
    const at = await selfPosition(client);
    const off = Math.hypot(at.x - want.x, at.y - want.y, at.z - want.z);
    if (at.map !== want.map || off > 3) {
      fail(`fixture did not land: map ${at.map} ${fmt(at)}, ${off.toFixed(1)}y from the scenario's ${fmt(want)} on map ${want.map}`);
    }
    for (const repro of start.repros) {
      const answer = await probe(client, repro.target, false);
      const outcome: Outcome = { repro, map: want.map, start: want, token, answer };
      log(`  ${repro.id} -> ${fmt(repro.target)}: ${describe(answer)}`);
      if (repro.forceStepDown && answer.data.status === "drop" && (answer.data.dz ?? 0) < 0 && answer.data.surfaceZ === undefined) {
        outcome.forced = await probe(client, repro.target, true);
        log(`  ${repro.id} with force: ${describe(outcome.forced)}`);
      }
      outcomes.push(outcome);
    }
  } finally {
    await client.logout().catch(() => {});
    client.close();
  }
}

/** This session's audit actions, or undefined when the directory or its files are not readable here. */
async function auditActions(token: string): Promise<Record<string, unknown>[] | undefined> {
  const stem = token.replace(/[^A-Za-z0-9_-]/g, "_");
  let names: string[];
  try {
    names = await readdir(AUDIT_DIR);
  } catch {
    return undefined;
  }
  const files = names.filter((f) => f.startsWith(stem) && /^(\.\d{4}-\d{2}-\d{2})?\.jsonl$/.test(f.slice(stem.length))).sort();
  if (files.length === 0) return undefined;
  const rows: Record<string, unknown>[] = [];
  for (const f of files) {
    for (const line of (await Bun.file(`${AUDIT_DIR}/${f}`).text()).split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as { kind?: string; payload?: Record<string, unknown> };
      if (row.kind === "action" && row.payload) rows.push(row.payload);
    }
  }
  return rows;
}

/** Segments of a polyline the guard refuses (unforced: either direction). */
function refusedSegments(points: Vec[]): number {
  let n = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dz = b.z - a.z;
    if (Math.abs(dz) > DROP_MIN_DZ && Math.abs(dz) > DROP_SLOPE * Math.hypot(b.x - a.x, b.y - a.y)) n++;
  }
  return n;
}

interface ReplanRow {
  outcome?: string;
  reason?: string;
  rounds?: number;
  excluded?: number;
  dz?: number;
  pointCount?: number;
  replanPointCount?: number;
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<{ ok?: boolean; build?: string }>);
if (health.ok !== true) {
  console.log(`FAIL: module health not ok: ${JSON.stringify(health)}`);
  process.exit(1);
}
log(`health ok: build=${health.build ?? "?"}; ${CHARACTER} on ${ACCOUNT}`);

const wanted = (process.env.SMOKE_REPROS ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => x.length > 0);
const chosen = STARTS.map((s) => ({ ...s, repros: s.repros.filter((r) => wanted.length === 0 || wanted.includes(r.id)) })).filter(
  (s) => s.repros.length > 0,
);
if (chosen.length === 0) {
  console.log(`FAIL: SMOKE_REPROS named none of ${STARTS.flatMap((s) => s.repros.map((r) => r.id)).join(", ")}`);
  process.exit(2);
}

const problems: string[] = [];
const outcomes: Outcome[] = [];
try {
  await ensureFixtureCharacter(fixtureCtx);
  for (const [n, start] of chosen.entries()) {
    try {
      await runStart(start, n, outcomes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`${start.scenario}: ${msg}`);
      log(`  FAIL ${start.scenario}: ${msg}`);
    }
  }
} catch (e) {
  problems.push(`fixture character: ${e instanceof Error ? e.message : String(e)}`);
}

// ------------------------------------------------------------- the report
const audits = new Map<string, Record<string, unknown>[] | undefined>();
for (const o of outcomes) if (!audits.has(o.token)) audits.set(o.token, await auditActions(o.token));
const auditReadable = [...audits.values()].some((rows) => rows !== undefined);

console.log("");
console.log(`steep re-plan reproductions (${outcomes.length} run; before = the module's verdict before the re-plan)`);
let refusals = 0;
let nowArrive = 0;
for (const o of outcomes) {
  const { repro, answer } = o;
  console.log(`${repro.id}  map ${o.map}  ${fmt(o.start)} -> ${fmt(repro.target)}`);
  console.log(`    before: ${repro.before}`);
  console.log(`    now:    ${describe(answer)}${o.forced ? `; with force: ${describe(o.forced)}` : ""}`);
  if (repro.control) {
    if (answer.data.status !== "target_off_mesh") problems.push(`${repro.id}: the control answered ${answer.data.status}, not target_off_mesh`);
    continue;
  }
  refusals++;
  if (answer.data.status === "arrived") nowArrive++;
  const rows = audits.get(o.token);
  if (rows === undefined) {
    console.log("    re-plan: audit not readable here");
    continue;
  }
  const replan = rows.find((p) => p.op === "move_replan_steep" && p.moveId === answer.moveId) as ReplanRow | undefined;
  const path = rows.find((p) => p.op === "move_path" && p.moveId === answer.moveId) as { points?: Vec[]; truncated?: boolean } | undefined;
  if (replan === undefined) {
    console.log("    re-plan: no move_replan_steep record (the mesh's own route passed the guard)");
    if (answer.data.status === "drop") problems.push(`${repro.id}: drop with no move_replan_steep record — does the running module predate the re-plan?`);
    continue;
  }
  const rounds = `${replan.rounds ?? 0} round${replan.rounds === 1 ? "" : "s"}, ${replan.excluded ?? 0} polygons barred`;
  const points = `${replan.pointCount ?? "?"} -> ${replan.replanPointCount ?? 0} points`;
  console.log(
    `    re-plan: ${replan.outcome}${replan.reason ? ` (${replan.reason})` : ""}, ${rounds}, ${points}; the mesh's route refused ${signed(replan.dz ?? 0)}`,
  );
  if (replan.outcome === "ok") {
    if (answer.data.status !== "arrived") problems.push(`${repro.id}: the re-planned walk ended ${answer.data.status}, not arrived`);
    const refused = refusedSegments(path?.points ?? []);
    if (path?.points === undefined) problems.push(`${repro.id}: no move_path polyline for the re-planned walk`);
    else if (refused > 0) problems.push(`${repro.id}: the re-planned route has ${refused} segment(s) the guard refuses`);
    else console.log(`    walked route: ${path.points.length}${path.truncated ? "+ (truncated)" : ""} points, none the guard refuses`);
  }
}
console.log("");
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const controls = outcomes.filter((o) => o.repro.control).map((o) => `${o.repro.id} ${o.answer.data.status}`);
console.log(
  `${nowArrive} of ${refusals} refusals now arrive; controls: ${controls.join(", ") || "none run"}; ` +
    `audit ${auditReadable ? "read" : "not readable here"}; build=${health.build ?? "?"} (${elapsed}s)`,
);
if (problems.length > 0) {
  for (const p of problems) console.log(`FAIL: ${p}`);
  process.exitCode = 1;
} else {
  console.log("PASS: steep-replan");
}
