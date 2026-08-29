/**
 * Probe for item text (FOLLOW-UPS 103): a readable letter obtained the way a
 * player gets one, read back through the client's own path.
 *
 * Arc: throwaway Human Warrior placed by `mcbride-report` (in front of
 * Marshal McBride with the Northshire chain up to quest 21 rewarded) ->
 * login -> acceptQuestFrom(McBride, 54 "Report to Goldshire"), whose start
 * item (Marshal McBride's Documents, a four-page letter) is handed over on
 * accept -> the item's tooltip arrives with a `pageText` -> readItem by name:
 * CMSG_READ_ITEM, SMSG_READ_ITEM_OK, the client's CMSG_PAGE_TEXT_QUERY, four
 * SMSG_PAGE_TEXT_QUERY_RESPONSE down the chain -> state.itemTexts() holds the
 * complete chain -> a `not_readable` on a plain item and a `no_item` on a name
 * nothing is carried under, both as values with hints -> logout and delete.
 *
 * What it proves: the page path end to end on server data, the template's
 * pageText served on the item query, the chain walk, and the two refusals.
 * What it does not: the mailed-letter path (CMSG_ITEM_TEXT_QUERY) — the mail
 * smoke sends money, not a letter with a body; it rides the same tap and is
 * left to the first trajectory that mails itself a note.
 *
 * It FAILS against any worldserver built before the taps (READ_ITEM_OK is not
 * whitelisted, so the wait times out). Run it only after the image is
 * deployed: it is the gate for the item 103 build.
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/read-item.ts
 */

import { connect, type WrathClient } from "../../sdk/src/index";
import { applyScenario, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const TOKEN = `smoke-read-item-${crypto.randomUUID()}`;
const CHARACTER = probeName("Br");
const SCENARIO = "mcbride-report";
const MCBRIDE = 197;
const QUEST_REPORT_TO_GOLDSHIRE = 54;
const DOCUMENTS = 745;
const DOCUMENTS_PAGES = 4;

const started = Date.now();
const log = (m: string) => console.log(`[read-item +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
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
      await c.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
      await c.logout();
    } finally {
      c.close();
    }
  },
};
let session: WrathClient | undefined;
try {
  await ensureFixtureCharacter(fixtureCtx);
  await applyScenario(fixtureCtx, SCENARIO);
  const client = await connect({ baseUrl: BASE, token: TOKEN });
  session = client;
  await client.createSession({ account: ACCOUNT, character: CHARACTER, race: 1, class: 1 });
  log(`in world as ${CHARACTER}, guid ${client.state.self.guid}`);
  await client.waitForNearby((o) => o.entry?.value === MCBRIDE, { timeout: 15_000 });
  const mcbride = client.state.units({ entry: MCBRIDE })[0] ?? fail("Marshal McBride is not in view");

  // 1. Accept the quest; its start item lands in the bags with a tooltip that carries a pageText.
  const accepted = await client.acceptQuestFrom(mcbride, QUEST_REPORT_TO_GOLDSHIRE, { timeout: 15_000 });
  log(`acceptQuestFrom: ${JSON.stringify({ ok: accepted.ok, status: accepted.status })}`);
  if (!accepted.ok) fail(`quest ${QUEST_REPORT_TO_GOLDSHIRE} not accepted: ${JSON.stringify(accepted)}`);
  const deadline = Date.now() + 15_000;
  while (!client.state.bag().items.some((i) => i.itemId === DOCUMENTS && i.name !== undefined)) {
    if (Date.now() > deadline) fail(`the documents (item ${DOCUMENTS}) never showed up named in state.bag(): ${JSON.stringify(client.state.bag().items)}`);
    await Bun.sleep(250);
  }
  const docs = client.state.bag().items.find((i) => i.itemId === DOCUMENTS)!;
  const info = client.state.items.get(DOCUMENTS)?.value ?? fail("no item query answer for the documents");
  if (info.pageText === undefined || info.pageText === 0) fail(`the documents' tooltip carries no pageText: ${JSON.stringify(info)}`);
  log(`PASS accept: ${JSON.stringify(docs.name)} at bag ${docs.bag} slot ${docs.slot}, pageText ${info.pageText}`);

  // 2. Read it by name: the whole chain, in order, and it stays in state.
  const read = await client.readItem("mcbride's documents", { timeout: 15_000 });
  if (!read.ok) fail(`readItem refused: ${read.status} — ${read.hint}`);
  log(`readItem: ${read.pages.length} page(s), ${read.text.length} chars, resolved=${JSON.stringify(read.resolved)}`);
  if (read.pages.length !== DOCUMENTS_PAGES) fail(`expected ${DOCUMENTS_PAGES} pages, got ${read.pages.length}`);
  if (read.pages.some((p) => p.length === 0)) fail("an empty page in the chain");
  const kept = client.state.itemTexts().find((t) => t.guid === docs.guid) ?? fail("state.itemTexts() lacks the documents after the read");
  if (!kept.complete || kept.pages.length !== DOCUMENTS_PAGES) fail(`state.itemTexts() holds ${kept.pages.length} page(s), complete=${kept.complete}`);
  log("PASS read: the full chain came back and state.itemTexts() keeps it");

  // 3. Refusals are values with hints: a plain item, and a name nothing is carried under.
  const plain = client.state.bag().items.find((i) => i.itemId !== DOCUMENTS && i.name !== undefined) ?? fail("no plain item in the bags to refuse on");
  const notReadable = await client.readItem(plain.bag, plain.slot, { timeout: 15_000 });
  if (notReadable.ok || notReadable.status !== "not_readable") fail(`reading ${plain.name} should be not_readable: ${JSON.stringify(notReadable)}`);
  const noItem = await client.readItem("Thunderfury");
  if (noItem.ok || noItem.status !== "no_item") fail(`reading Thunderfury should be no_item: ${JSON.stringify(noItem)}`);
  const hints = client.drainActionHints().map((h) => `${h.action}:${h.status}`);
  if (!hints.includes("readItem:not_readable") || !hints.includes("readItem:no_item")) fail(`hints missing: ${hints.join(", ")}`);
  log(`PASS refusals: ${hints.join(", ")}`);
  console.log(`PASS: read-item (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  await session?.logout().catch(() => {});
  session?.close();
  await deleteFixtureCharacters(fixtureCtx, [CHARACTER]);
}
