/**
 * Probe for the skill pane (FOLLOW-UPS 95): the `PLAYER_SKILL_INFO` update
 * fields served on the self create block (`skill<n>Id/Step/Value/Max/
 * TempBonus/PermBonus`) with the SkillLine.dbc name beside each id, folded
 * into `state.skills()`.
 *
 * It FAILS against any worldserver built before the change (no skill
 * fields, `skills()` empty). Run it only after the image is deployed.
 *
 * Arc: fresh Human Paladin -> login -> skills() lists the starting lines
 * (a weapon skill, an armor class, Defense, Language: Common) every one
 * named, Defense at level*5 max -> logout and delete.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/skills.ts
 */

import { connect } from "../../sdk/src/index";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-skills-${crypto.randomUUID()}`;
const CHARACTER = probeName("Bs");
const SKILL_DEFENSE = 95;
const SKILL_LANGUAGE_COMMON = 98;

const started = Date.now();
const log = (m: string) => console.log(`[skills +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}`);

const client = await connect({ baseUrl: BASE, token: TOKEN });
try {
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 2 });
  log(`in world as ${CHARACTER}, level ${client.state.self.level?.value}`);
  await Bun.sleep(1500); // the self create block lands with the first update after login
  const skills = client.state.skills();
  log(`skills: ${JSON.stringify(skills.map((s) => [s.skillId, s.name, `${s.value}/${s.max}`]))}`);
  if (skills.length < 4) fail(`only ${skills.length} skill line(s); a fresh paladin has a weapon, armor, Defense and a language`);
  const unnamed = skills.filter((s) => s.name === undefined);
  if (unnamed.length > 0) fail(`${unnamed.length} skill(s) without a SkillLine.dbc name: ${JSON.stringify(unnamed)}`);
  const defense = client.state.skill(SKILL_DEFENSE) ?? fail("no Defense line");
  const level = client.state.self.level?.value ?? 1;
  if (defense.max !== level * 5) fail(`Defense max ${defense.max}, expected ${level * 5}`);
  if (!/defense/i.test(defense.name!)) fail(`Defense is named ${JSON.stringify(defense.name)}`);
  const common = client.state.skill(SKILL_LANGUAGE_COMMON) ?? fail("no Language: Common line");
  if (common.value !== 300) fail(`Language: Common at ${common.value}, expected 300`);
  if (client.state.skill("defense")?.skillId !== SKILL_DEFENSE) fail("skill(\"defense\") by name did not resolve");
  console.log(`PASS: skills (${skills.length} lines, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => {});
  await client.deleteCharacter(CHARACTER, { account: ACCOUNT }).catch((e) => log(`delete failed: ${String(e)}`));
  client.close();
}
