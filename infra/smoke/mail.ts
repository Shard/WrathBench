/**
 * Probe for the mail surface (mail): the mailbox frame
 * (`openMailbox` -> `SMSG_SHOW_MAILBOX`), `sendMail` with money answered by
 * `SMSG_SEND_MAIL_RESULT`, the recipient's `mailList` (`SMSG_MAIL_LIST_RESULT`
 * with the sender joined by name), `takeMailMoney` and `deleteMail`.
 *
 * It FAILS against any worldserver built before the taps. Run it only after
 * the image is deployed: one of the gates for that build.
 *
 * Two throwaway characters on ONE account, in sequence: the core refuses mail
 * to yourself (MAIL_ERR_CANNOT_SEND_TO_SELF) and delays items across
 * accounts by an hour, while money between characters of the same account
 * is immediate. Both are placed at the Goldshire mailbox by the
 * `mailbox-goldshire` scenario (level 1, 50s: postage is 30c).
 *
 * Run from inside the network:
 *   docker compose -f infra/compose.yml exec runner bun infra/smoke/mail.ts
 */

import { connect, type WrathClient } from "../../sdk/src/index";
import { applyScenario, deleteFixtureCharacters, ensureFixtureCharacter, type FixtureContext } from "./lib/fixture";
import { probeName } from "./lib/name";
import { authHeaders, MODULE_SECRET } from "./lib/auth";

const BASE = `http://${process.env.MODULE_HOST ?? "worldserver"}:${process.env.MODULE_PORT ?? "8086"}`;
const ACCOUNT = process.env.MODULE_ACCOUNT ?? "PROBE";
const RUN = crypto.randomUUID();
const SENDER = probeName("Bms");
const RECEIVER = probeName("Bmr");
const SCENARIO = "mailbox-goldshire";
const MONEY = 100;
const POSTAGE = 30;
const SUBJECT = `smoke ${RUN.slice(0, 8)}`;

const started = Date.now();
const log = (m: string) => console.log(`[mail +${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${m}`);
function fail(m: string): never {
  throw new Error(m);
}

const health = await fetch(`${BASE}/health`, { headers: authHeaders() }).then((r) => r.json() as Promise<any>);
if (!health?.ok) fail(`health not ok: ${JSON.stringify(health)}`);
log(`health ok: build=${health.build ?? "?"}; ${SENDER} -> ${RECEIVER} on ${ACCOUNT}`);

function ctxFor(character: string, token: string): FixtureContext {
  return {
    base: BASE,
    account: ACCOUNT,
    character,
    token,
    log,
    fail,
    contendedDeadlineMs: 10_000,
    contendedRetryMs: 5_000,
    createAndLogout: async () => {
      const c = await connect({ baseUrl: BASE, token: `${token}-create`, secret: MODULE_SECRET });
      try {
        await c.createSession({ account: ACCOUNT, character, race: 1, class: 1 });
        await c.logout();
      } finally {
        c.close();
      }
    },
  };
}

async function atMailbox(client: WrathClient, character: string) {
  await client.createSession({ account: ACCOUNT, character, race: 1, class: 1 });
  await client.waitForNearby((o) => o.objectType?.value === "gameObject" && o.fields.get("goType")?.value === 19, { timeout: 15_000 });
  // The self create block (money) lands with the first update after login; poll for it.
  const moneyBy = Date.now() + 10_000;
  while (client.state.money === undefined && Date.now() < moneyBy) await Bun.sleep(100);
  log(`in world as ${character}, money ${client.state.money?.value}`);
  const mailbox = client.state.units({ type: "gameObject" }).find((u) => u.goType === "mailbox") ?? fail("no mailbox in view");
  if (mailbox.distance === undefined || mailbox.distance > 8) fail(`the mailbox is ${mailbox.distance}y away — did apply.ts place the character?`);
  const box = await client.openMailbox(mailbox, { timeout: 10_000 });
  log(`mailbox ${mailbox.name ?? mailbox.guid} open (frame guid ${box.guid}, ${box.mails.length} mail(s) listed)`);
}

const tokenS = `smoke-mail-s-${RUN}`;
const tokenR = `smoke-mail-r-${RUN}`;
let sender: WrathClient | undefined;
let receiver: WrathClient | undefined;
try {
  for (const [name, token] of [
    [SENDER, tokenS],
    [RECEIVER, tokenR],
  ] as const) {
    const ctx = ctxFor(name, token);
    await ensureFixtureCharacter(ctx);
    await applyScenario(ctx, SCENARIO);
  }

  // 1. The sender mails money to the receiver.
  sender = await connect({ baseUrl: BASE, token: tokenS, secret: MODULE_SECRET });
  await atMailbox(sender, SENDER);
  const moneyBefore = sender.state.money?.value ?? fail("sender money unobserved");
  const sent = await sender.sendMail(RECEIVER, SUBJECT, "sent by the mail smoke", { money: MONEY, timeout: 10_000 });
  log(`sendMail: ${JSON.stringify(sent)}`);
  if (!sent.ok) fail(`send refused: ${sent.hint}`);
  await Bun.sleep(1000);
  const moneyAfter = sender.state.money?.value ?? fail("sender money unobserved after send");
  if (moneyBefore - moneyAfter !== MONEY + POSTAGE) fail(`sender money ${moneyBefore} -> ${moneyAfter}, expected -${MONEY + POSTAGE}`);
  log(`PASS send: money ${moneyBefore} -> ${moneyAfter}`);
  await sender.logout();
  sender.close();
  sender = undefined;

  // 2. The receiver lists, takes the money, deletes the mail.
  receiver = await connect({ baseUrl: BASE, token: tokenR, secret: MODULE_SECRET });
  await atMailbox(receiver, RECEIVER);
  const box = await receiver.mailList({ timeout: 10_000 });
  log(`inbox: ${JSON.stringify(box.mails.map((m) => [m.mailId, m.senderName, m.subject, m.money]))}`);
  const mail = box.mails.find((m) => m.subject === SUBJECT) ?? fail(`no mail with subject ${JSON.stringify(SUBJECT)} in the inbox`);
  if (mail.money !== MONEY) fail(`mail carries ${mail.money} copper, expected ${MONEY}`);
  if (mail.senderName !== SENDER) fail(`senderName ${JSON.stringify(mail.senderName)}, expected ${SENDER} (name query on the sender guid)`);
  const rMoneyBefore = receiver.state.money?.value ?? fail("receiver money unobserved");
  const took = await receiver.takeMailMoney(mail.mailId, { timeout: 10_000 });
  if (!took.ok) fail(`takeMailMoney refused: ${took.hint}`);
  await Bun.sleep(1000);
  const rMoneyAfter = receiver.state.money?.value ?? fail("receiver money unobserved after take");
  if (rMoneyAfter - rMoneyBefore !== MONEY) fail(`receiver money ${rMoneyBefore} -> ${rMoneyAfter}, expected +${MONEY}`);
  if (receiver.state.mailbox()?.mails.find((m) => m.mailId === mail.mailId)?.money !== 0) fail("the cached mail still carries money after the take");
  const deleted = await receiver.deleteMail(mail.mailId, { timeout: 10_000 });
  if (!deleted.ok) fail(`deleteMail refused: ${deleted.hint}`);
  if (receiver.state.mailbox()?.mails.some((m) => m.mailId === mail.mailId)) fail("the deleted mail is still in the cached inbox");
  log(`PASS receive: +${MONEY} copper, mail deleted`);
  console.log(`PASS: mail (${((Date.now() - started) / 1000).toFixed(1)}s)`);
} catch (e) {
  console.log(`FAIL: ${String(e instanceof Error ? (e.stack ?? e.message) : e)}`);
  process.exitCode = 1;
} finally {
  for (const c of [sender, receiver]) {
    if (c === undefined) continue;
    await c.logout().catch(() => {});
  }
  sender?.close();
  receiver?.close();
  await deleteFixtureCharacters({ base: BASE, account: ACCOUNT, token: `smoke-mail-x-${RUN}`, log }, [SENDER, RECEIVER]);
}
