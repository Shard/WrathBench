/**
 * Probe for the pet surface (FOLLOW-UPS 98): `SMSG_PET_SPELLS` folded into
 * `state.pet()` (guid, given name from the pet name query, creature name,
 * level/health from the pet's own unit, named spells), the pet commands
 * built as `CMSG_PET_ACTION` (`petAttack`, `petFollow`, `petDismiss`), and
 * the bar removal clearing `state.pet()`.
 *
 * It FAILS against any worldserver built before the tap (the raw opcode is
 * refused and `state.pet()` never fills). Run it only after the image is
 * deployed: it is the gate for the item 98 build.
 *
 * Warlock, not hunter: a level-1 warlock knows Summon Imp (688) and needs no
 * tame, so the whole arc fits a throwaway character. The tame path
 * (Tame Beast → the same SMSG_PET_SPELLS) rides the same tap and is left to
 * a hunter trajectory to confirm.
 *
 * Arc: throwaway Human Warlock placed by `vineyard-kill-credit` (the
 * Northshire vineyard edge, Kobold Vermin in view) -> login -> castSpell(688)
 * -> state.pet() with a guid, "Imp" as the creature name, a given name, and
 * Firebolt in its book -> petAttack(nearest Kobold Vermin) -> the pet's own
 * SMSG_ATTACKERSTATEUPDATE or SMSG_SPELL_GO (or a PET_ACTION_FEEDBACK) ->
 * petFollow -> petDismiss -> state.pet() undefined -> logout and delete.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/pet.ts
 */

import { connect, isEvent, isDecodeError, petFeedbackText } from "../../sdk/src/index";
import { applyScenario, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-pet-${crypto.randomUUID()}`;
const CHARACTER = probeName("Bp");
const SCENARIO = "vineyard-kill-credit";
const SUMMON_IMP = 688;
const KOBOLD_VERMIN = 6;

const started = Date.now();
const log = (m: string) => console.log(`[pet +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}, character=${CHARACTER} on ${ACCOUNT}`);

const fixtureCtx: FixtureContext = {
  base: BASE,
  account: ACCOUNT,
  character: CHARACTER,
  token: TOKEN,
  log,
  fail,
  contendedDeadlineMs: 10_000,
  contendedRetryMs: 5_000,
  createAndLogout: async () => {
    const c = await connect({ baseUrl: BASE, token: `${TOKEN}-create` });
    try {
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 9 });
      await c.logout();
    } finally {
      c.close();
    }
  },
};
await ensureFixtureCharacter(fixtureCtx);
await applyScenario(fixtureCtx, SCENARIO);

const client = await connect({ baseUrl: BASE, token: TOKEN });
try {
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 9 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  await Bun.sleep(1500);
  if (client.state.spell(SUMMON_IMP) === undefined) fail("Summon Imp (688) is not in the spellbook — is the character a warlock?");
  if (client.state.pet() !== undefined) fail("a pet is already out before summoning");

  // 1. Summon: a 6-10s cast, then SMSG_PET_SPELLS with the imp's bar.
  await client.castSpell(SUMMON_IMP);
  const petEvent = await client.events.waitFor((e) => isEvent(e, "SMSG_PET_SPELLS") && !isDecodeError(e.data) && !(e.data as any).removed, { timeout: 30_000 });
  log(`SMSG_PET_SPELLS seq ${petEvent.seq}: ${JSON.stringify(petEvent.data).slice(0, 300)}`);
  await Bun.sleep(1500); // the pet's create block, creature query and name query land around the bar
  const pet = client.state.pet() ?? fail("state.pet() is undefined after SMSG_PET_SPELLS");
  log(`pet: ${JSON.stringify({ guid: pet.guid, name: pet.name, creatureName: pet.creatureName, level: pet.level, health: pet.health, reaction: pet.reaction, command: pet.command, spells: pet.spells.map((s) => s.name) })}`);
  if (!pet.inView) fail("the pet's unit is not in view (no create block for its guid)");
  if (pet.creatureName !== "Imp") fail(`creatureName ${JSON.stringify(pet.creatureName)}, expected "Imp"`);
  if (pet.name === undefined) fail("no given name — SMSG_PET_NAME_QUERY_RESPONSE did not arrive (did the module send CMSG_PET_NAME_QUERY on the pet number?)");
  if (pet.level === undefined || pet.health === undefined) fail("pet level/health unobserved");
  if (client.state.petSpell("Firebolt") === undefined) fail(`Firebolt missing from the pet's book: ${JSON.stringify(pet.spells)}`);
  const unnamed = pet.spells.filter((s) => s.name === undefined);
  if (unnamed.length > 0) fail(`${unnamed.length} pet spell(s) without a name`);
  const owner = client.state.units().find((u) => u.guid === pet.guid)?.ownerGuid;
  if (owner !== client.state.self.guid) fail(`the pet's ownerGuid is ${owner}, expected our own ${client.state.self.guid}`);
  log("PASS summon: bar, unit, names and owner all joined");

  // 2. Attack the nearest Kobold Vermin; the pet's own swing or a feedback code proves the command landed.
  await client.waitForNearby((o) => o.entry?.value === KOBOLD_VERMIN, { timeout: 15_000 });
  const vermin = client.state.units({ entry: KOBOLD_VERMIN, alive: true })[0] ?? fail("no live Kobold Vermin in view");
  const sinceSeq = client.events.recent(1)[0]?.seq ?? 0;
  const ordered = await client.petAttack(vermin);
  if (!ordered.ok) fail(`petAttack sent nothing: ${ordered.status} — ${ordered.hint}`);
  const verdict = await client.events.waitFor(
    (e) =>
      e.seq > sinceSeq &&
      ((isEvent(e, "SMSG_ATTACKERSTATEUPDATE") && !isDecodeError(e.data) && (e.data as any).attackerGuid === pet.guid) ||
        (isEvent(e, "SMSG_SPELL_GO") && !isDecodeError(e.data) && (e.data as any).casterGuid === pet.guid) ||
        isEvent(e, "SMSG_PET_ACTION_FEEDBACK")),
    { timeout: 20_000 },
  );
  if (isEvent(verdict, "SMSG_PET_ACTION_FEEDBACK")) fail(`petAttack refused: ${petFeedbackText((verdict.data as any).feedback)}`);
  log(`PASS attack: the imp's ${verdict.opcode} at seq ${verdict.seq}`);

  // 3. Follow (ack-only; the core sets the command state without a packet), then dismiss.
  const followed = await client.petFollow();
  if (!followed.ok) fail(`petFollow sent nothing: ${followed.status} — ${followed.hint}`);
  await Bun.sleep(1000);
  const removeSeq = client.events.recent(1)[0]?.seq ?? 0;
  const dismissed = await client.petDismiss();
  if (!dismissed.ok) fail(`petDismiss sent nothing: ${dismissed.status} — ${dismissed.hint}`);
  await client.events.waitFor((e) => e.seq > removeSeq && isEvent(e, "SMSG_PET_SPELLS") && !isDecodeError(e.data) && (e.data as any).removed === true, { timeout: 15_000 });
  if (client.state.pet() !== undefined) fail("state.pet() still set after the bar was removed");
  log("PASS dismiss: bar removed, state.pet() undefined");
  console.log(`PASS: pet (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  await client.deleteCharacter(CHARACTER, { account: ACCOUNT }).catch((e) => log(`delete failed: ${String(e)}`));
  client.close();
}
