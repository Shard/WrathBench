/**
 * Probe for possession control (wrath-mcp #4, vehicle and possession): the
 * Death Knight start's Eye of Acherus, the possessed flying unit the module
 * now drives. A control handover observed (`SMSG_CLIENT_CONTROL_UPDATE` on
 * `state.self.control`), the possessed unit's bar on `state.pet()`, a
 * `moveTo` flown by the Eye (`mover` and `flight` on the verdict), and the
 * recall returning control.
 *
 * It FAILS against any worldserver built before the mover drives a possessed
 * unit (`moveTo` answers `controlling`). Run it only after that image is
 * deployed: it is the gate for that build. It is not a suite member and not
 * a deploy smoke: `bun wb smoke eye-of-acherus` alone.
 *
 * Two throwaway characters, because a Death Knight cannot be created on an
 * account without a level-55 character (CharacterCreating.
 * MinLevelForHeroicCharacter): a sponsor the `acherus-sponsor` fixture raises
 * to 55 and never logs in, then the knight, created through the module as
 * any character is and placed by `acherus-eye` on the Acherus heights with
 * Death Comes From On High (12641) in its log. The realm allows one Death
 * Knight per account (HeroicCharactersPerRealm), so a knight a killed run
 * left behind is deleted first, by its prefix.
 *
 * Arc: login -> the Eye of Acherus Control Mechanism (gameobject 191609) in
 * view -> interact (CMSG_GAMEOBJ_USE: the goober casts 51888, which summons
 * the Eye and possesses it) -> SMSG_CLIENT_CONTROL_UPDATE granting the Eye
 * (state.self.control.mover) and its bar (state.pet(), Recall Eye of
 * Acherus among its spells) -> the Eye's scripted flight from Acherus down
 * to New Avalon, during which a moveTo is refused `rooted` or ends
 * `interrupted` (the server flies it): retried until the script hands the
 * Eye over -> moveTo flown by the Eye: `arrived` with `mover` the Eye and
 * `flight: true` -> petCast(Recall Eye of Acherus) -> control back
 * (state.self.control.mover is our own guid) -> logout and delete both.
 *
 * Run from inside the network:
 *   bun wb smoke eye-of-acherus
 *   bun wb --local smoke eye-of-acherus   # the quickstart
 */

import { connect, isEvent, isDecodeError, type WrathClient } from "@wrathbench/sdk";
import { applyScenario, characterNames, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";
import { moduleBase } from "./lib/module";
import { smokeSubToken, smokeToken } from "./lib/session";

const BASE = moduleBase();
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = smokeToken("eye-of-acherus");
/** The knight and the sponsor, by prefix: a leftover of either is deleted before the run. */
const KNIGHT_PREFIX = "Bv";
const SPONSOR_PREFIX = "Bw";
const KNIGHT = probeName(KNIGHT_PREFIX);
const SPONSOR = probeName(SPONSOR_PREFIX);
const CLASS_WARRIOR = 1;
const CLASS_DEATH_KNIGHT = 6;
const QUEST_DEATH_COMES_FROM_ON_HIGH = 12641;
const GO_EYE_CONTROL_MECHANISM = 191609;
const RECALL = "Recall Eye of Acherus";
/**
 * Where the Eye's scripted flight ends (waypoint path 2851100, point 3: the
 * air over New Avalon), and the point the smoke flies it to from there: 32y
 * east and 10y up, a short straight line with nothing of New Avalon's in it.
 */
const EYE_HANDOVER = { x: 1758.01, y: -5876.78, z: 166.867 };
const FLIGHT_TARGET = { x: EYE_HANDOVER.x + 32, y: EYE_HANDOVER.y, z: EYE_HANDOVER.z + 10 };
/** The scripted flight is well under this; a handover that never comes is the failure. */
const HANDOVER_BUDGET_MS = 180_000;

const started = Date.now();
const log = (m: string) => console.log(`[eye-of-acherus +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, knight=${KNIGHT}, sponsor=${SPONSOR} on ${ACCOUNT}`);

function fixtureFor(character: string, cls: number, suffix: string): FixtureContext {
  return {
    base: BASE,
    account: ACCOUNT,
    character,
    token: TOKEN,
    log,
    fail,
    contendedDeadlineMs: 10_000,
    contendedRetryMs: 5_000,
    createAndLogout: async () => {
      const c = await connect({ baseUrl: BASE, token: smokeSubToken(TOKEN, suffix), secret: MODULE_SECRET });
      try {
        await c.createSession({ account: ACCOUNT, character, race: 1, class: cls });
        await c.logout();
      } finally {
        c.close();
      }
    },
  };
}
const sponsorCtx = fixtureFor(SPONSOR, CLASS_WARRIOR, "sponsor");
const knightCtx = fixtureFor(KNIGHT, CLASS_DEATH_KNIGHT, "knight");

let session: WrathClient | undefined;
try {
  // A knight or sponsor a killed run left behind: the realm's one-knight rule
  // would refuse today's create, and the sponsor would be one more toward the
  // account's cap.
  const leftovers = (await characterNames(sponsorCtx)).filter((n) => n.startsWith(KNIGHT_PREFIX) || n.startsWith(SPONSOR_PREFIX));
  if (leftovers.length > 0) {
    log(`deleting leftovers from an earlier run: ${leftovers.join(", ")}`);
    await deleteFixtureCharacters(sponsorCtx, leftovers);
  }
  await ensureFixtureCharacter(sponsorCtx);
  await applyScenario(sponsorCtx, "acherus-sponsor");
  await ensureFixtureCharacter(knightCtx);
  await applyScenario(knightCtx, "acherus-eye");

  const client = await connect({ baseUrl: BASE, token: TOKEN, secret: MODULE_SECRET });
  session = client;
  await client.createSession({ account: ACCOUNT, character: KNIGHT, race: 1, class: CLASS_DEATH_KNIGHT });
  const self = client.state.self.guid ?? fail("no own guid after login");
  log(`in world as ${KNIGHT}, guid ${self}`);
  // The quest log and the objects around land asynchronously after the login burst.
  const logBy = Date.now() + 10_000;
  while (client.state.quest(QUEST_DEATH_COMES_FROM_ON_HIGH) === undefined && Date.now() < logBy) await Bun.sleep(100);
  if (client.state.quest(QUEST_DEATH_COMES_FROM_ON_HIGH) === undefined) fail("Death Comes From On High (12641) is not in the log — did the acherus-eye fixture apply?");
  const mechanism = await client.waitForNearby((o) => o.entry?.value === GO_EYE_CONTROL_MECHANISM, { timeout: 10_000 });
  const reach = client.state.units({ type: "gameObject" }).find((u) => u.guid === mechanism.guid)?.distance;
  log(`control mechanism in view: ${mechanism.guid} at ${reach?.toFixed(1) ?? "?"}y`);
  // Read through a call each time: the cache mutates under the awaits, and a
  // narrowed property read would keep its first reading.
  const readControl = () => client.state.self.control;
  if (readControl() !== undefined) fail(`a control update arrived before the interact: ${JSON.stringify(readControl())}`);

  // 1. Use the mechanism: the goober's spell summons the Eye and hands it over.
  const sinceSeq = client.state.lastSeq;
  const used = await client.interact(mechanism.guid);
  if (!used.ok) fail(`interact refused: ${JSON.stringify(used)}`);
  const granted = await client.events.waitFor(
    (e) => e.seq > sinceSeq && isEvent(e, "SMSG_CLIENT_CONTROL_UPDATE") && !isDecodeError(e.data) && (e.data as any).allowMove === true && (e.data as any).guid !== self,
    { timeout: 30_000 },
  );
  const eye = (granted.data as any).guid as string;
  log(`SMSG_CLIENT_CONTROL_UPDATE seq ${granted.seq}: the Eye is ${eye}`);
  const control = readControl() ?? fail("state.self.control is undefined after the grant");
  if (control.value.mover !== eye || !control.value.allowMove) fail(`state.self.control reads ${JSON.stringify(control.value)}, expected the Eye with allowMove`);
  await client.events.waitFor((e) => e.seq > sinceSeq && isEvent(e, "SMSG_PET_SPELLS") && !isDecodeError(e.data) && (e.data as any).guid === eye, { timeout: 15_000 });
  await Bun.sleep(1000); // the Eye's create block and the spell names
  const bar = client.state.pet() ?? fail("state.pet() is undefined after the Eye's bar");
  if (bar.guid !== eye) fail(`state.pet() is ${bar.guid}, expected the Eye ${eye}`);
  if (client.state.petSpell(RECALL) === undefined) fail(`${RECALL} missing from the Eye's bar: ${JSON.stringify(bar.spells.map((s) => s.name))}`);
  log(`PASS handover: control and bar on the Eye, spells ${JSON.stringify(bar.spells.map((s) => s.name))}`);

  // 2. Fly it. The script roots the Eye, flies it down to New Avalon on its
  // own spline and unroots it there: a move before that is refused `rooted`
  // or dropped by the server mid-spline (`interrupted`), and is retried.
  const handoverBy = Date.now() + HANDOVER_BUDGET_MS;
  let flown: Extract<Awaited<ReturnType<typeof client.moveTo>>, { status: "arrived" }> | undefined;
  for (;;) {
    const r = await client.moveTo(FLIGHT_TARGET, { timeout: 60_000 });
    if (r.ok && r.status === "arrived") {
      flown = r;
      break;
    }
    if ((r.status === "rooted" || r.status === "interrupted") && Date.now() < handoverBy) {
      log(`  ${r.status} (the script still flies the Eye); retrying`);
      await Bun.sleep(3000);
      continue;
    }
    fail(`moveTo on the Eye: ${r.status}${"hint" in r && r.hint ? ` — ${r.hint}` : ""}`);
  }
  if (flown === undefined) fail("unreachable: the loop ends on an arrival or a failure");
  if (flown.mover !== eye) fail(`the arrival names mover ${flown.mover}, expected the Eye ${eye}`);
  if (flown.flight !== true) fail("the arrival was not flown (flight is not true)");
  const eyeNow = client.state.units().find((u) => u.guid === eye);
  log(`PASS flight: arrived at ${JSON.stringify(flown.position)} as the Eye (in view at ${eyeNow?.x?.toFixed(1)}, ${eyeNow?.y?.toFixed(1)})`);

  // 3. Recall: the Eye's own spell ends the possession; control comes back.
  const recallSeq = client.state.lastSeq;
  const recalled = await client.petCast(RECALL);
  if (!recalled.ok) fail(`petCast(${RECALL}) sent nothing: ${recalled.status} — ${recalled.hint}`);
  await client.events.waitFor(
    (e) => e.seq > recallSeq && isEvent(e, "SMSG_CLIENT_CONTROL_UPDATE") && !isDecodeError(e.data) && (e.data as any).allowMove === true && (e.data as any).guid === self,
    { timeout: 30_000 },
  );
  const back = readControl() ?? fail("state.self.control is undefined after the recall");
  if (back.value.mover !== self || !back.value.allowMove) fail(`control after the recall reads ${JSON.stringify(back.value)}`);
  log("PASS recall: control returned to the character");
  console.log(`PASS: eye-of-acherus (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await session?.logout().catch(() => {});
  session?.close();
  await deleteFixtureCharacters(knightCtx, [KNIGHT, SPONSOR]);
}
