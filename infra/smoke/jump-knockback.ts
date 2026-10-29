/**
 * Probe for the jump (wrath-mcp #4, "Jump"): a character jumps in place and
 * forward on the Northshire start, and a second character beside it watches
 * the jumps arrive as any client nearby sees them (wrath-mcp/module/
 * PROTOCOL.md, "jump" and "Arcs").
 *
 * The `jump` action is posted directly and its landing read off the event
 * stream (`WB_SELF_MOVE` cause `jump`), so the probe needs only a module
 * that serves the action, not the SDK's `jump()`.
 *
 * Asserts, and exits 1 on any miss:
 *   1. in place: the landing is reported within 3 s, within 0.5y of the
 *      start across and 1y in height;
 *   2. forward (facing east first): the landing is 3 to 8 yards east of the
 *      start (the run speed over a jump's ~0.8 s);
 *   3. the observer receives the jumper's MSG_MOVE_JUMP carrying
 *      MOVEMENTFLAG_FALLING, and a MSG_MOVE_FALL_LAND without it, for each
 *      jump: the server accepted and relayed them;
 *   4. a moveTo back to the start arrives (the landing left the character
 *      standing, not running), and the jumper's health is unchanged.
 *
 * Knockbacks need a mob that casts one and are not driven here: the live
 * check is a character walking into a knockback (the PR says which), with
 * the audit log's `knockback_ack` and `arc_start` rows and a `WB_SELF_MOVE`
 * cause `knockback` where it lands.
 *
 * It FAILS against any worldserver built before the module serves `jump`
 * (`400 unsupported_action`). Not a suite member and not a deploy smoke:
 *
 *   kubectl -n wrathbench exec deploy/wrathbench-runner -- env MODULE_ACCOUNT=SMOKE4 bun infra/smoke/jump-knockback.ts
 *   bun wb smoke jump-knockback
 *
 * MODULE_ACCOUNT (default SMOKE4, which has room for a fixture character;
 * PROBE sits at the realm's ten-character cap) jumps; the observer is
 * MODULE_ACCOUNT_OBSERVER, default SMOKE3. Coordinates are harness
 * tooling's, not an agent run's.
 */

import { connect, type StreamEvent, type WrathClient } from "@wrathbench/sdk";
import { SCENARIOS, type ScenarioName } from "../fixtures/scenarios";
import { accountFixtureName, applyScenario, characterNames, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { smokeToken } from "./lib/session";

const BASE = moduleBase();
const JUMPER_ACCOUNT = process.env.MODULE_ACCOUNT ?? "SMOKE4";
const OBSERVER_ACCOUNT = process.env.MODULE_ACCOUNT_OBSERVER ?? "SMOKE3";
const JUMPER = process.env.SMOKE_CHARACTER ?? accountFixtureName("Jp", JUMPER_ACCOUNT);
const OBSERVER = process.env.SMOKE_CHARACTER2 ?? accountFixtureName("Jq", OBSERVER_ACCOUNT);
const RUN = crypto.randomUUID();
const SCENARIO: ScenarioName = "northshire-fresh";

const MOVEMENTFLAG_FALLING = 0x00001000;
const LANDING_MS = 3000;

type Vec = { x: number; y: number; z: number };

const started = Date.now();
const log = (m: string): void => console.log(`[jump-knockback +${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const fmt = (p: Vec): string => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(2)})`;

class SmokeFailed extends Error {}
function fail(m: string): never {
  throw new SmokeFailed(m);
}

function fixtureCtx(account: string, character: string, tag: string): FixtureContext {
  const ctx: FixtureContext = {
    base: BASE,
    account,
    character,
    token: smokeToken("jump-knockback", { role: tag, id: RUN }),
    log,
    fail,
    contendedDeadlineMs: 10_000,
    contendedRetryMs: 5_000,
    createAndLogout: async () => {
      const client = await connect({ baseUrl: BASE, token: smokeToken("jump-knockback", { role: tag, id: RUN, suffix: "create" }), secret: MODULE_SECRET });
      try {
        await client.createSession({ account, character, race: 1, class: 1 });
        await client.logout();
      } finally {
        client.close();
      }
    },
  };
  return ctx;
}

async function placeAndLogin(account: string, character: string, tag: string): Promise<{ client: WrathClient; token: string }> {
  const ctx = fixtureCtx(account, character, tag);
  await characterNames(ctx);
  await ensureFixtureCharacter(ctx);
  await applyScenario(ctx, SCENARIO);
  const token = smokeToken("jump-knockback", { role: tag, id: RUN, suffix: "play" });
  const client = await connect({ baseUrl: BASE, token, secret: MODULE_SECRET });
  await client.createSession({ account, character, race: 1, class: 1 });
  const want = SCENARIOS[SCENARIO].position;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const at = client.state.self.position?.value;
    if (at !== undefined) {
      if (at.map !== want.map || Math.hypot(at.x - want.x, at.y - want.y) > 3) fail(`${character}: fixture did not land: ${fmt(at)} on map ${at.map}`);
      return { client, token };
    }
    if (Date.now() > deadline) fail(`${character}: no self position observed after login`);
    await Bun.sleep(100);
  }
}

/** POST the `jump` action and wait for its landing on the stream. */
async function jump(client: WrathClient, token: string, forward: boolean): Promise<{ landed: Vec; ackMs?: number }> {
  const sinceSeq = client.state.lastSeq;
  const res = await fetch(`${BASE}/action`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ token, action: "jump", ...(forward ? { forward: true } : {}) }),
  });
  const ack = (await res.json()) as { ok?: boolean; error?: string; etaMs?: number };
  if (!res.ok || ack.ok !== true) fail(`jump${forward ? " forward" : ""} refused: ${res.status} ${JSON.stringify(ack)}`);
  const ev: StreamEvent = await client.events.waitFor(
    (e) => e.seq > sinceSeq && e.opcode === "WB_SELF_MOVE" && (e.data as { cause?: string } | undefined)?.cause === "jump",
    { timeout: LANDING_MS, description: "the jump's landing (WB_SELF_MOVE cause jump)" },
  );
  return { landed: (ev.data as { pos: Vec }).pos, ...(ack.etaMs !== undefined ? { ackMs: ack.etaMs } : {}) };
}

const health0 = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<{ ok?: boolean; build?: string }>);
if (health0.ok !== true) {
  console.log(`FAIL: module health not ok: ${JSON.stringify(health0)}`);
  process.exit(1);
}
log(`health ok: build=${health0.build ?? "?"}; ${JUMPER} on ${JUMPER_ACCOUNT} jumps, ${OBSERVER} on ${OBSERVER_ACCOUNT} watches`);

const problems: string[] = [];
const notes: string[] = [];
let jumper: WrathClient | undefined;
let observer: WrathClient | undefined;
try {
  observer = (await placeAndLogin(OBSERVER_ACCOUNT, OBSERVER, "obs")).client;
  const placed = await placeAndLogin(JUMPER_ACCOUNT, JUMPER, "jump");
  jumper = placed.client;
  const jumperGuid = String(jumper.state.self.guid ?? fail("jumper has no guid after login"));
  const seen: { opcode: string; flags: number; pos: Vec }[] = [];
  observer.events.onAny((e) => {
    if (!e.opcode.startsWith("MSG_MOVE")) return;
    const d = e.data as { guid?: unknown; flags?: number; pos?: Vec } | undefined;
    if (d === undefined || String(d.guid) !== jumperGuid || d.flags === undefined || d.pos === undefined) return;
    seen.push({ opcode: e.opcode, flags: d.flags, pos: d.pos });
  });
  await Bun.sleep(2000);
  const hp0 = jumper.state.self.health?.value ?? fail("jumper's health not observed after login");
  const start = jumper.state.self.position?.value ?? fail("no start position");
  log(`both in world; jumper at ${fmt(start)}, health ${hp0.current}/${hp0.max}`);

  // 1. In place.
  const still = await jump(jumper, placed.token, false);
  const across = Math.hypot(still.landed.x - start.x, still.landed.y - start.y);
  log(`  in place: landed ${fmt(still.landed)}, ${across.toFixed(2)}y across, eta ${still.ackMs ?? "?"}ms`);
  if (across > 0.5 || Math.abs(still.landed.z - start.z) > 1) problems.push(`in place: landed ${across.toFixed(2)}y across and ${(still.landed.z - start.z).toFixed(2)}y up from the start`);
  await Bun.sleep(500);

  // 2. Forward, facing east.
  await jumper.face(0);
  await Bun.sleep(300);
  const from = jumper.state.self.position?.value ?? start;
  const ahead = await jump(jumper, placed.token, true);
  const east = ahead.landed.x - from.x;
  log(`  forward: landed ${fmt(ahead.landed)}, ${east.toFixed(2)}y east, eta ${ahead.ackMs ?? "?"}ms`);
  if (east < 3 || east > 8) problems.push(`forward: landed ${east.toFixed(2)}y east of the start, outside 3-8`);
  await Bun.sleep(1000);

  // 3. What the observer saw.
  const jumps = seen.filter((m) => m.opcode === "MSG_MOVE_JUMP");
  const lands = seen.filter((m) => m.opcode === "MSG_MOVE_FALL_LAND");
  notes.push(`observer saw ${seen.length} of the jumper's movement packets: ${jumps.length} MSG_MOVE_JUMP, ${lands.length} MSG_MOVE_FALL_LAND`);
  for (const m of [...jumps, ...lands]) notes.push(`  ${m.opcode} flags 0x${m.flags.toString(16)} at ${fmt(m.pos)}`);
  if (jumps.length < 2) problems.push(`the observer saw ${jumps.length} MSG_MOVE_JUMP, expected 2`);
  if (jumps.some((m) => (m.flags & MOVEMENTFLAG_FALLING) === 0)) problems.push("a relayed MSG_MOVE_JUMP lacks MOVEMENTFLAG_FALLING");
  if (lands.length < 2) problems.push(`the observer saw ${lands.length} MSG_MOVE_FALL_LAND, expected 2`);
  if (lands.some((m) => (m.flags & MOVEMENTFLAG_FALLING) !== 0)) problems.push("a relayed MSG_MOVE_FALL_LAND still carries MOVEMENTFLAG_FALLING");

  // 4. Standing after it: a walk back arrives, and nothing hurt.
  const back = await jumper.moveTo({ x: start.x, y: start.y, z: start.z }, { timeout: 30_000 });
  log(`  walk back: ${back.status}`);
  if (back.status !== "arrived") problems.push(`the walk back ended ${back.status}`);
  await Bun.sleep(1000);
  const hp1 = jumper.state.self.health?.value ?? fail("jumper's health not observed at the end");
  if (hp1.current < hp0.current) problems.push(`the jumper lost health: ${hp0.current} -> ${hp1.current}`);
} catch (e) {
  problems.push(e instanceof Error ? e.message : String(e));
} finally {
  for (const c of [jumper, observer]) {
    if (c === undefined) continue;
    await c.logout().catch(() => {});
    c.close();
  }
}

for (const n of notes) console.log(n);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (problems.length > 0) {
  for (const p of problems) console.log(`FAIL: ${p}`);
  console.log(`build=${health0.build ?? "?"} (${elapsed}s)`);
  process.exitCode = 1;
} else {
  console.log(`PASS: jump-knockback (build=${health0.build ?? "?"}, ${elapsed}s)`);
}
