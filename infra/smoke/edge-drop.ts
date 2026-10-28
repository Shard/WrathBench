/**
 * The edge drop, end to end: a move off the end of a plateau's mesh, by the
 * living and by a ghost (module/PROTOCOL.md, `path_incomplete`, operator
 * decision 2026-10-28).
 *
 * The plateau is Skettis in Terokkar Forest, whose mesh links to nothing
 * below: a freeplay ghost released at its graveyard (1298, Lake Jorune GY)
 * 143y over its corpse was refused every move down as `path_incomplete`.
 * The module now walks on from the end of the mesh's route toward a request
 * that lies below it, falls from the edge, and routes on from the landing.
 *
 * One fixture character (infra/fixtures/scenarios.ts `edge-drop-skettis`,
 * level 80, full health) at the graveyard's release point:
 *   1. a raw `move_to` to the freeplay ghost's own request on the lowland,
 *      without `force`: `drop` with the edge as `reachedPos`, a fall far past
 *      the guard's 2y (`dz`), and nothing moved. A `path_incomplete` here is
 *      the old module (or an edge it cannot find) and fails the smoke;
 *   2. the SDK's `moveTo` to the same point: the fall is lethal at any level
 *      (the server charges all of max health past ~70y), so it answers
 *      `drop` with nothing moved. Should its estimate let the fall through,
 *      the arrival is checked instead and the ghost legs are skipped;
 *   3. the same `move_to` with `force`: the character walks off the edge and
 *      the server's own Player::HandleFall kills it on the landing — the
 *      proof the fall was charged as a client's. A survival is reported, and
 *      ends the smoke there;
 *   4. release: the ghost lands at a graveyard. When that is above the corpse
 *      (1298 is, for this corpse; the core picks by faction and distance, so
 *      it is not asserted), the ghost's `moveTo` to the corpse must take the
 *      edge — the SDK forces a ghost's drop — and arrive within reclaim
 *      range; then the reclaim. A graveyard that is not above the corpse
 *      skips the ghost's edge with a note and walks to the corpse as it can.
 *
 * An operator smoke, not a deploy smoke and not in the suite: it runs on
 * PROBE (never a gate account), writes one fixture placement, and a run that
 * fails between the death and the reclaim leaves the character a ghost,
 * which the next run reports at login rather than building on.
 *
 *   bun wb smoke edge-drop
 *
 * `SMOKE_CHARACTER` names the fixture character; MODULE_ACCOUNT (default
 * PROBE) is the runner's environment. Coordinates are the incident's own
 * (harness tooling, not an agent run; the observation contract does not apply
 * to this script).
 */

import { connect, type MovePoint, type MoveResultData, type WrathClient } from "../../sdk/src/index";
import { EDGE_SKETTIS_TARGET, SCENARIOS } from "../fixtures/scenarios";
import { accountFixtureName, applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const CHARACTER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Ed", ACCOUNT);
const RUN = crypto.randomUUID();
const SCENARIO = "edge-drop-skettis" as const;
// A 130y fall walked at run speed, plus the leg below: well inside this.
const MOVE_TIMEOUT_MS = 120_000;
// The guard, as the module states it (PROTOCOL.md `drop`).
const DROP_MIN_DZ = 2.0;
// The core's reclaim radius (CORPSE_RECLAIM_RADIUS), as the SDK uses it.
const RECLAIM_RADIUS = 39;

const started = Date.now();
const log = (m: string): void => console.log(`[edge +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);

class SmokeFailed extends Error {}
function fail(m: string): never {
  throw new SmokeFailed(m);
}

type Vec = { x: number; y: number; z: number };
const fmt = (p: Vec): string => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
const dist2d = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

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
  token: `smoke-edge-${RUN}`,
  log,
  fail,
  createAndLogout: async () => {
    const client = await connect({ baseUrl: BASE, token: `smoke-edge-${RUN}-create`, secret: MODULE_SECRET });
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
async function probe(client: WrathClient, target: MovePoint, force: boolean): Promise<MoveResultData> {
  const ack = await client.moveToAsync(target, { force });
  if (ack.moveId === undefined) fail(`moveToAsync refused before sending: ${ack.status} — ${ack.hint ?? ""}`);
  const ev = await client.events.waitFor(
    (e) => e.opcode === "WB_MOVE_RESULT" && (e.data as { moveId?: number } | undefined)?.moveId === ack.moveId,
    { timeout: MOVE_TIMEOUT_MS, description: `WB_MOVE_RESULT for moveId ${ack.moveId}` },
  );
  return ev.data as MoveResultData;
}

/** Wait for the cache to say what the server said, up to `ms`. */
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(200);
  }
  return true;
}

async function main(): Promise<void> {
  const want = SCENARIOS[SCENARIO].position;
  const target: MovePoint = { ...EDGE_SKETTIS_TARGET };
  log(`${CHARACTER} on ${ACCOUNT}: ${SCENARIO} at map ${want.map} ${fmt(want)}, target ${fmt(target)}`);
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);
  const client = await connect({ baseUrl: BASE, token: `smoke-edge-${RUN}`, secret: MODULE_SECRET });
  try {
    await createSessionWithBackoff(client);
    const at = await selfPosition(client);
    if (client.state.self.ghost?.value === true) {
      fail(`${CHARACTER} logged in a ghost: an earlier run failed between its death and its reclaim; walk it to its corpse and reclaim before running this again`);
    }
    const off = Math.hypot(at.x - want.x, at.y - want.y, at.z - want.z);
    if (at.map !== want.map || off > 3) {
      fail(`fixture did not land: map ${at.map} ${fmt(at)}, ${off.toFixed(1)}y from the scenario's ${fmt(want)} on map ${want.map}`);
    }

    // 1. Unforced: `drop` at the edge past the mesh, nothing moved.
    const raw = await probe(client, target, false);
    if (raw.status !== "drop") {
      const reached = raw.reachedPos ? `, reachedPos ${fmt(raw.reachedPos)}` : "";
      fail(
        `unforced move off the plateau answered ${raw.status}${reached}, want drop at the edge past the mesh (a module before the edge drop answers path_incomplete); ` +
          `why, from the module's own record: bun wb inspect audit --smoke edge --op move_edge_drop --since 1h`,
      );
    }
    if (!raw.reachedPos) fail(`drop carries no reachedPos: ${JSON.stringify(raw)}`);
    if (typeof raw.dz !== "number" || raw.dz >= -DROP_MIN_DZ) fail(`drop's dz should be a fall past ${DROP_MIN_DZ}y: ${JSON.stringify(raw)}`);
    if (raw.surfaceZ !== undefined) fail(`the edge drop's landing reads as under the ground (surfaceZ ${raw.surfaceZ}): ${JSON.stringify(raw)}`);
    if (dist2d(raw.pos, at) > 1 || Math.abs(raw.pos.z - at.z) > 1) fail(`the unforced drop moved the character: ${fmt(raw.pos)} from ${fmt(at)}`);
    if (!raw.target || dist2d(raw.target, target) > 0.01) fail(`drop should echo the requested target: ${JSON.stringify(raw)}`);
    const edge = raw.reachedPos;
    const landingZ = edge.z + raw.dz;
    log(`PASS[unforced]: drop at the edge ${fmt(edge)}, ${(-raw.dz).toFixed(1)}y down to z ${landingZ.toFixed(1)}; nothing moved`);

    // 2. The SDK's own verdict for the living: a lethal fall is left at the edge.
    const health = client.state.self.health?.value;
    const judged = await client.moveTo(target, { timeout: MOVE_TIMEOUT_MS });
    if (judged.status === "arrived") {
      const there = await selfPosition(client);
      log(`NOTE[sdk]: moveTo took the ${(-raw.dz).toFixed(1)}y fall on its own (health ${health?.current}/${health?.max}); arrived at ${fmt(there)}: ${judged.hint ?? ""}`);
      if (dist2d(there, target) > 5) fail(`moveTo arrived ${dist2d(there, target).toFixed(1)}y from the target`);
      log("PASS: the living took the edge drop and arrived; no death, so the ghost legs are not run");
      return;
    }
    if (judged.status !== "drop") fail(`SDK moveTo answered ${judged.status}, want drop (a lethal fall left at the edge): ${judged.hint ?? ""}`);
    const still = await selfPosition(client);
    if (dist2d(still, at) > 1) fail(`the SDK's refused drop moved the character: ${fmt(still)} from ${fmt(at)}`);
    log(`PASS[sdk]: moveTo left the ${(-raw.dz).toFixed(1)}y fall at the edge: ${judged.hint ?? "(no hint)"}`);

    // 3. Forced: the walk, the fall, and the server's charge on the landing.
    const forced = await probe(client, target, true);
    const dead = await until(() => client.state.self.health?.value.current === 0, 5_000);
    if (!dead) {
      if (forced.status !== "arrived") fail(`forced move off the plateau answered ${forced.status} at ${fmt(forced.pos)} and the character is alive`);
      log(`NOTE[forced]: survived the ${(-raw.dz).toFixed(1)}y fall (health ${client.state.self.health?.value.current}); arrived at ${fmt(forced.pos)}`);
      log("PASS: the forced edge drop was walked; no death, so the ghost legs are not run");
      return;
    }
    const corpse = await selfPosition(client);
    if (corpse.z > edge.z - DROP_MIN_DZ) fail(`died at ${fmt(corpse)}, not below the edge ${fmt(edge)}`);
    if (Math.abs(corpse.z - landingZ) > 5) log(`NOTE[forced]: the body lies at z ${corpse.z.toFixed(1)}, the drop named z ${landingZ.toFixed(1)}`);
    log(`PASS[forced]: walked off the edge and the server's fall killed the character at ${fmt(corpse)} (${forced.status})`);

    // 4. The ghost: release, and the move down from wherever the release put it.
    await client.repop();
    if (!(await until(() => client.state.self.ghost?.value === true, 10_000))) fail("no ghost flag after repop");
    const ghost = await selfPosition(client);
    log(`released to ${fmt(ghost)}, ${dist2d(ghost, corpse).toFixed(0)}y from the corpse and ${(ghost.z - corpse.z).toFixed(0)}y above it`);
    let run = await client.moveTo({ x: corpse.x, y: corpse.y, z: corpse.z }, { timeout: MOVE_TIMEOUT_MS });
    // The body lies where the fall landed, which may be off the mesh (the leg
    // below may have started from the mesh up to 10y away): then the move is
    // to the walkable ground the module names beside it, within reclaim range.
    if (!run.ok && run.status === "target_off_mesh" && run.nearest) {
      log(`  the corpse is off the mesh; moving to the nearest walkable ground ${fmt(run.nearest)} instead`);
      run = await client.moveTo(run.nearest, { timeout: MOVE_TIMEOUT_MS });
    }
    if (ghost.z - corpse.z <= DROP_MIN_DZ) {
      log(`NOTE[ghost]: the release point is not above the corpse, so the ghost's edge drop is not exercised here (${run.status})`);
    } else if (run.status !== "arrived") {
      fail(`the ghost's move down to its corpse answered ${run.status}, want arrived over the edge: ${run.hint ?? ""}`);
    }
    const near = await selfPosition(client);
    if (run.status === "arrived") log(`PASS[ghost]: the ghost went over the edge and arrived ${dist2d(near, corpse).toFixed(1)}y from its corpse: ${run.hint ?? ""}`);
    if (dist2d(near, corpse) > RECLAIM_RADIUS) fail(`the ghost ended ${dist2d(near, corpse).toFixed(0)}y from its corpse, outside the reclaim radius; it is left a ghost`);
    const reclaim = await client.reclaimCorpse();
    if (reclaim.status !== "reclaimed") fail(`reclaim answered ${reclaim.status}; the character is left a ghost`);
    log("PASS[reclaim]: alive at the corpse");
    log("PASS: unforced drop at the edge past the mesh -> SDK leaves a lethal fall -> forced fall charged by the server -> ghost over the edge -> reclaim");
  } finally {
    await client.logout().catch(() => {});
    client.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    log(`FAIL: ${e instanceof SmokeFailed ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  },
);
