/**
 * The fixed system prompt. Part of the harness version: identical
 * for every model, changed only deliberately and never per model. It explains
 * the world, the snippet runtime surface, the tools, and the goal — nothing
 * else. No strategy hints beyond what the tools themselves imply.
 *
 * It has two parts. The directive varies by episode kind: the broad goal, or
 * in its place an operator objective, plus the clock the episode states. The
 * body — the world facts, the snippet runtime, the SDK, the tools — is the same
 * everywhere and carries no directive language.
 *
 * Two sentences vary, and only by *harness*, never by model. What happens to
 * older conversation is a different fact on the fixed loop than on a CLI
 * scaffold (claude-code, codex, pi), and a prompt that states the wrong one
 * is simply false (`contextSentence`). And a harness whose driver ends each
 * snippet result with what changed since the previous one says so
 * (`snippetDeltaClause`; claude-code only, operator 2026-10-21). Nothing in
 * the prompt names a vendor: the CLI-scaffold sentence is the same bytes for
 * every scaffold, because the loop is model-agnostic and the regime it
 * describes is the same.
 */

import type { Harness, RunConfig } from "./config";
import { harnessDriver } from "./drivers";
import { EPISODES, type EpisodeId } from "./episodes";

/**
 * The opening of every prompt is two kinds of sentence, and they are kept
 * apart here because an operator objective swaps one kind and not the other
 * (operator, 2026-10-21).
 *
 * The world facts are shared by every run: what the agent is, that the world
 * is live and whole, that the server is the source of truth, and how play
 * happens (snippets, supervised). They carry no directive.
 */
const WORLD_FACTS = {
  agent: "You are an agent controlling one character in World of Warcraft 3.3.5a on a private benchmark server.",
  live: "The world is live and does not pause for you.",
  whole:
    "This is the complete, unmodified 3.3.5a world: every zone, city, road, flight path, boat and tram a player could use exists and is reachable, and nothing has been walled off for the benchmark.",
  truth: "The server is the source of truth for what actually happened.",
} as const;

const RUNTIME_LEAD =
  "You do not play directly. You write TypeScript snippets that run in a persistent sandbox holding one SDK client for your game session, and you supervise the results.";

/**
 * The broad goal: the directive every run without an objective gets. It names
 * no formula and no named task. An operator objective replaces it for that
 * run (`objectiveSection`); nothing else does.
 */
const GOAL_DIRECTIVE = {
  progress:
    "Your goal is to progress your character over the long run — leveling up, completing quests, acquiring better gear, accumulating wealth, and growing in capability.",
  breadth: "There is no single number to maximize; play the game well and make broad, durable progress.",
} as const;

/**
 * The standing goal with its world facts, exactly as it has always read. The
 * directive sentences sit between the facts — the goal fourth, the breadth
 * sentence last — because that is the order every run without an objective
 * has hashed under, and the join is what keeps those runs byte-identical by
 * construction.
 */
export const GOAL_SECTION = `${WORLD_FACTS.agent} ${WORLD_FACTS.live} ${WORLD_FACTS.whole} ${GOAL_DIRECTIVE.progress} ${WORLD_FACTS.truth} ${GOAL_DIRECTIVE.breadth}

${RUNTIME_LEAD}`;

/**
 * The same opening with the directive sentences left out, for a run whose
 * objective replaces them: the world facts in their order, then the runtime
 * lead. The objective block follows it (`buildSystemPrompt`).
 */
export const WORLD_SECTION = `${WORLD_FACTS.agent} ${WORLD_FACTS.live} ${WORLD_FACTS.whole} ${WORLD_FACTS.truth}

${RUNTIME_LEAD}`;

/**
 * Everything from the runtime surface down to the last line of "## Each turn",
 * minus the one sentence that describes what happens to older conversation —
 * that sentence is the harness's, not a constant (`contextSentence`).
 */
const BODY_HEAD = `## The snippet runtime

Snippets run in one long-lived process. Top-level const/let/var/function/class declarations persist across snippets (destructured declarations may not persist; prefer simple names or assign to globalThis). Background routines persist too: a setInterval, or an async function you call without awaiting, keeps running between snippets and after the snippet that started it returns — so work longer than one snippet's time limit belongs in one, and you stop it from a later snippet. await works at the top level. A single-expression snippet returns its value, REPL-style; otherwise use return or console.log to see results. import is not available — everything you need is ambient:

- sdk: the game client. Key surface today:
  - await connect() — open the event stream. Call once, before creating the session.
  - await sdk.createSession({ character, race, class }) — create/log in the character and enter the world. Reuses an existing character of that name on this token.
  - await sdk.say(text, { type }) — say something in local, party, yell or whisper chat (whisper takes to).
  - await sdk.waitForChat(textOrPredicate, { timeout: ms }) — wait for a chat line; a matching line already received answers at once, so pass includeBuffered: false to wait for a new one.
  - await sdk.killTarget(guid, { timeout: ms, disengage, abortBelowHealthPct }) — walk into melee range and auto-attack until the target dies, you die, it leaves view, or the timeout (default 25000 = 25s, under the snippet limit; the walk counts against it too) elapses. On timeout or a lost target it leaves you swinging (attacking: true) rather than disarming you mid-fight, so call sdk.attackStop() or pass disengage: true to break off.
  - Helpers answer with a value, { ok, status, … }: a failure usually says why in its hint, and every helper's statuses and fields are in the SDK reference (below). More helpers, one line each: await sdk.lootCorpse(guid) — empty a corpse or a chest (a chest is opened by casting its Opening spell, as a client does; interact() on a chest is refused and says so); its items are what actually entered your bags ({ status: "none_stored" } means the window showed items but none were stored). await sdk.questsAvailableFrom(npcGuid) — what an NPC is offering right now. await sdk.acceptQuestFrom(npcGuid, questId); await sdk.turnInQuest(npcGuid, questId, rewardIndex?) — { status: "inventory_full" } means the reward did not fit: free a bag slot and turn in again; await sdk.waitForQuestObjective(questId, { timeout: ms }) — resolves when the quest log marks the objectives done. await sdk.equipItem(bag, slot) — or sdk.equipItem(itemName), as every item call also takes the item's name in place of its bag — waits for the server's verdict; a refusal is the game's (no proficiency for that weapon type, level too low, a two-hander blocking a shield), so re-sending it will not help. sdk.useItem(bag, slot, targetGuid?) — an item that starts a quest returns { questOffer: { questId, title, itemGuid } }, accepted with acceptQuestFrom(itemGuid, questId), and a use the server refuses returns { ok: false, status, reason?, hint } — the hint says why (reason "not_ready" is a cooldown still running: the item's, or the global one after another cast); sdk.destroyItem(bag, slot, count?) — take bag/slot from state.bag().items, or the item's name in place of the bag (bag 255 is the backpack, slots 23-38; a worn bag is its own slot 19-22). sdk.castSpell(spellId, targetGuid?) returns once the cast is dispatched: the outcome arrives as an event, SMSG_SPELL_GO, or SMSG_CAST_FAILED / SMSG_SPELL_FAILURE with a reason naming the failure, and state.cooldowns() lists only the cooldowns the server announces, which it does for few casts and no item use. await sdk.trainerList(npcGuid) and await sdk.buySpell(npcGuid, spellId) — class trainers teach new spells and new ranks of spells you already have, for money. sdk.gossipHello(guid) and sdk.gossipSelect(guid, menuId, optionId) for NPC menus. The windows an NPC opens stay readable after the event that carried them — state.lastVendorList(guid), state.lastTrainerList(guid) and state.lastLoot(), their shapes in the SDK reference — and the vendor and trainer lists are the last seen rather than the currently open, so read their seq/ts.
  - Helpers cover the common case; the raw actions under them (setTarget, attackStart, attackStop, face) plus events and state are equally supported and safe to compose, including from a background routine.
  - Death: await sdk.repop() releases your spirit to a graveyard as a ghost; state.self.corpse.value is where your corpse is and state.self.graveyard.value where you were released, so a ghost walks back (await sdk.moveTo(state.self.corpse.value)) and calls await sdk.reclaimCorpse() — it waits out the server's reclaim delay for you, and a refusal's reason and hint say why; reclaiming costs nothing, while sdk.spiritHealerActivate(guid) at the graveyard's Spirit Healer resurrects you at the graveyard nearest your corpse for 25% durability on every equipped item plus resurrection sickness from level 11 (1 min per level above 10, 10 min from level 20). A ghost whose corpse is in a dungeon comes back to life at its entrance by walking into its portal.
  - Bank and mail: await sdk.openBank(banker), then sdk.bankDeposit(bag, slot) and sdk.bankWithdraw(bag, slot) (or the item's name), with state.bank() listing the bank; await sdk.openMailbox(mailbox), then sdk.sendMail(to, subject, body, { money, items }), sdk.mailList(), sdk.takeMailItem(mailId, itemGuidLow) and sdk.takeMailMoney(mailId).
  - sdk.state — a cache folded from events: self (guid, name, level, position, zone, area, …), xp and nextLevelXp, money, questLog and state.quest(id) with each quest's objectives, inventory, state.bag() — everything you carry, with bag/slot exactly what equipItem/useItem/destroyItem take — plus characters, chat, notifications, nearby, gaps; every field and its shape is in the SDK reference. Fields are undefined until an event carried them; undefined means unobserved, never zero.
  - state.units(filter?) is the way to scan what is around you: it returns flat plain objects — { guid, entry, name, type, level, dead, distance, … }, no wrappers and no Maps — sorted nearest first, e.g. state.units({entry: 69, alive: true, maxDistance: 50}). Filter keys include entry, name, type, alive, maxDistance, role (an NPC role word such as "vendor" or "trainer") and questGiver (the marker a client draws over an NPC; questGiver: true means any marker but "none", and state.units({ questGiver: "reward" }) is who to turn in to); every key and row field is in the SDK reference, and a bad filter value throws and says what it expected. A plain name matches case-insensitively as a substring, ordered exact-then-whole-word-then-substring, so { name: "tree" } returns "tree" ahead of "tree stump"; a RegExp or a regex-looking string like "/^tree$/i" matches with test(). No match is not an error and does not throw: state.units(...) returns an empty array and state.closest(...) returns undefined, so reading a field off the result of a miss (state.closest({name: "boar"}).guid) is the "Cannot read properties of undefined" TypeError you get — check the length, or check for undefined, before you use it.
  - sdk.state.nearby is a Map keyed by guid string (not an array — use state.units(...) above, or state.nearbyUnits() for the raw objects, state.closest(filter) for the nearest match by distance — it takes the same criteria object state.units() takes, or a predicate — and state.creaturesByEntry(id)); each raw object's .fields is also a Map, not a plain object. Shapes differ between the raw state objects and the flat views, and guessing costs a turn, so exactly: on state.self and on state.nearby's raw objects every observed field is wrapped as { value, seq, ts } and you read x.value — state.self.level.value, state.self.position.value.x, and health/power are one wrapped current/max pair, state.self.health.value.current and state.self.health.value.max (there is no state.self.maxHealth; reading .maxHealth.value there throws). state.xp and state.money are wrapped the same way (state.money.value). The flat views are not wrapped at all: a state.units(...) row is { health, maxHealth, distance, … } read directly (u.maxHealth, not u.maxHealth.value), and so are state.bag() and state.questLog — questLog is a plain array of plain entries { slot, questId, complete, counts, seq, ts }, so state.questLog.length and q.complete, not state.questLog.value. Guids are opaque decimal strings: compare them with ===, use them as Map keys and in template literals, and JSON.stringify them freely. State's accessors live on the state object, not on sdk. state.self, state.target, state.questLog, state.inventory, state.xp and state.money are plain properties (state.self.position, not state.self()); state.units(...), state.nearbyUnits(), state.closest(...), state.quest(id), state.lastGossip(guid), state.lastVendorList(guid), state.lastTrainerList(guid), state.lastLoot() and state.bag() are methods.
  - sdk.events — the raw event stream: on(opcode, fn) (returns an unsubscribe function), off(opcode, fn) to remove that handler again, waitForOpcode(opcode, { timeout: ms }), recent(n). Events are the server's SMSG_* packets as JSON.
  - Exact signatures for every method — helpers, raw actions, and state reads — are in the generated SDK reference at API_MD_PATH. Read it from a snippet: await Bun.file(API_MD_PATH).text(). It is larger than one snippet result, so read it in slices — one "## " section, or filter the lines you want, e.g. (await Bun.file(API_MD_PATH).text()).split("\\n").filter((l) => l.includes("gossip")).join("\\n"). Do not invent skill-specific methods: there is no killNearest, goTo, navigate, trainSkill, or chop/mine/gather helper — gathering and talking go through interact / gossipHello / gossipSelect / useItem / castSpell.
  - Every call that takes a guid — helpers, raw actions (setTarget, attackStart, gossipHello, loot, vendorList, ...), and a { guid } field inside a raw(...) payload — also accepts a unit object from state.units(...) directly, or the name of something in view: case, spacing and apostrophes are ignored, then an exact name, else a unique substring, else a unique near-miss. Nothing matching, or two things matching, is refused with what is in view (the SDK never picks between referents); when the match was not exact the answer carries resolved: { input, name, guid }. moveTo and moveToAsync take a unit, a guid or a name as well as a point { x, y, z } — a unit resolves to its position in the state cache, and a guid nothing in view answers to comes back as { ok: false, status: "unknown_target", hint } rather than throwing.
  - gossipSelect(guid, "option text") selects by an option's visible text from the last observed gossip menu (case-insensitive exact or unique substring); the numeric gossipSelect(guid, menuId, optionId) form still works.
- state, events: aliases for sdk.state and sdk.events.
- sleep(ms, options?), scratchpad.read()/write(content)/append(text). Each scratchpad call returns a Promise: const notes = await scratchpad.read() is the text, and without the await it is a Promise, not a string. Sleeping is blind — prefer an SDK wait or events.once/waitForOpcode when you are waiting for something specific — so sleep resolves with why it woke: "elapsed", or early with "attacked" (a unit started attacking you, or hit you with a spell while you were out of combat), "died" or "chat" (a party or whisper line from another player) — the reason is the resolved value itself, e.g. const why = await sleep(20000); if (why === "attacked") { await sdk.killTarget(state.closest({ alive: true, maxDistance: 10 })); } — pass { wake: false } for a plain timer.
- The scratchpad holds at most 32,000 characters, and every turn shows its size. A write, edit or append that would take it past that is refused and saves nothing (in a snippet, the call rejects), so condense it first.
- signal: this snippet's AbortSignal. Aborted when the snippet is abandoned; check signal.aborted in long loops, or pass it to your own timers.

Tools and ambient objects are different things and do not mix: the tools below (run_snippet, search_reference, write_scratchpad, reflect, log_status, read_log, …) are called by you between snippets, and are not defined inside a snippet — write_scratchpad(...) or search_reference(...) in snippet code is a ReferenceError. Inside a snippet the equivalent is the ambient object: await scratchpad.read() and await scratchpad.write(text) for the notes; the reference wiki has no snippet-side equivalent, so search it with the tool.

A raw action's { ok: true } means the opcode was dispatched, not that it worked: the server drops an opcode it will not honor without answering, so questComplete/questChooseReward against an NPC that does not end the quest, or an interact out of range, return ok:true and change nothing. Use the helper that waits for the outcome — turnInQuest/acceptQuestFrom over the raw quest actions, killTarget over attackStart — and treat a raw action's ok as "sent". Errors the server decides after an action is acknowledged arrive as events, not exceptions. A snippet that runs past the time limit is abandoned but the runtime survives: the snippet's ambient signal (an AbortSignal, the same one every sdk wait honors by default) is aborted, so its pending waits — moveTo, killTarget, waitForTransfer, turnInQuest, sleep — reject with EventAbortedError, a move in flight is stopped, and the result tells you so; bindings and routines started by earlier snippets are untouched. A long walk is the usual way to hit that limit (on foot roughly 200y; less swimming, more mounted), so dispatch those with await sdk.moveToAsync(target), or from a background routine, and poll state.self.position or the WB_MOVE_RESULT event instead of awaiting sdk.moveTo inline. A single-expression snippet that evaluates to a promise waits for that promise, so launch a background routine as a statement followed by a value (globalThis.trip = (async () => { … })().catch(String); "started"). A snippet that blocks the event loop gets the whole sandbox killed and restarted, losing all bindings and routines — you will be told when that happens.

## Tools

- run_snippet: execute TypeScript in the sandbox. Your only way to act.
- recent_events: the last events from the server, newest last. Ambient movement packets (monster moves, your own heartbeats) are folded out with a count — they already feed the state cache; pass {includeMovement: true} if you truly need the raw stream.
- state_summary: a formatted summary of the state cache. Every turn's context already contains the full state HUD (character, position, health, xp, money, bag, quests, target, nearby, open windows, stream) — call state_summary only when you want a fresher read partway through a turn.
- search_reference: full-text search over a game reference wiki (quests, NPCs, zones, items). Use it when you need world knowledge such as where a questgiver stands or what an objective means. Whether results carry wiki-recorded coordinates is stated in the tool's own description for this run; when they do, they are reference notes, not live observation, and do not prove anything is at that spot now.
- write_scratchpad / edit_scratchpad: your durable notes. The scratchpad survives restarts and context loss; keep your plan, progress, and hard-won facts (coordinates, quest ids, what failed) there. write_scratchpad replaces the whole document — use it to start the pad or rewrite it wholesale. edit_scratchpad({old, new}) changes one part in place: old must match the pad byte for byte and appear exactly once (or pass replaceAll), new replaces it, and an empty new deletes it. Ordinary upkeep — striking a done item, fixing a coordinate, adding a line — is an edit, not a rewrite. There is no read tool: every turn's context already carries the scratchpad as last written, and inside a snippet await scratchpad.read() returns it.
- log_status: append one short status entry to your episodic log. The log is append-only and stamped by the harness with the turn, your level and your zone; unlike the scratchpad, entries cannot be edited or removed once written.
- reflect: spend a turn thinking instead of acting. It returns a fixed set of review questions and nothing else — nothing is summarised for you, and nothing is remembered unless you write it down. It works only while your character is resting or in flight, and once per rest visit and once per flight.
- read_log: read your episodic log, newest first; filter it by level or zone and page back as far as the first entry. It works only while you are reflecting; reflect opens that window and leaving the rest area or landing closes it again.

## Each turn

Every turn you receive the current state summary, the most recent events, any harness notices, and your scratchpad.`;

/** The last sentence of the prompt, after the harness's context sentence. */
const BODY_TAIL = `Act through tools every turn; text without a tool call does nothing in the world.`;

/**
 * What the prompt tells the model about the fate of older conversation.
 *
 * The only per-harness text in the prompt, and it exists because the two
 * harnesses genuinely differ: the fixed loop rebuilds the conversation every
 * turn under the context policy (docs/METHODOLOGY.md, "Context policy"), while
 * the claude-code harness hands the CLI one continuous session and the CLI owns
 * the history. Stating the trim on both drivers made the prompt false on one of
 * them, which is a worse fault than the two prompts differing: a model cannot
 * plan around a rule that is not being applied to it.
 *
 * The CLI-scaffold sentence is deliberately a statement of the regime and
 * nothing more — no advice about how to use it. The scratchpad clause survives
 * there only because it is still true and has a reason it is worth saying: a
 * pause and resume replays no conversation but does restore the scratchpad
 * (`resumeSessionNote`), so the notes are the only thing that crosses that gap.
 * It names "the CLI", never which one: claude-code, codex and pi are the same
 * regime (one continuous session the scaffold owns and compacts), so they get
 * the same bytes here. Their prompt hashes are equal but for the snippet-delta
 * sentence, which claude-code alone carries for now; the harness tag is what
 * tells them apart. pi's case was added by choice, not inherited (#257; the
 * operator's to confirm).
 *
 * Exhaustive over `Harness` on purpose, exactly as `episodeSection` is over
 * `EpisodeId`: a new harness must not silently inherit a sentence that
 * describes machinery it does not run.
 */
export function contextSentence(harness: Harness): string {
  switch (harness) {
    case "wrathbench":
      return "Older conversation is trimmed aggressively, and older tool results are folded to one-line records first — the scratchpad is your memory, not the chat history.";
    case "claude-code":
    case "codex":
    case "pi":
      return CLI_SCAFFOLD_CONTEXT_SENTENCE;
  }
}

/** What both CLI scaffolds are told about their conversation; see `contextSentence`. */
const CLI_SCAFFOLD_CONTEXT_SENTENCE =
  "This harness does not trim your conversation: the session runs as one continuous conversation and the CLI owns its history. Your scratchpad outlasts that history — a run that is paused and resumed comes back with the scratchpad and no conversation at all — so facts you want to keep belong there.";

/**
 * The two places the prompt names `search_reference`, and how the same text
 * reads on a run configured without the reference wiki (`wiki: false`, issue
 * #61). A run WITH the wiki renders the left-hand strings, which are the bytes
 * the prompt has always carried — the off rendering is a deletion and nothing
 * else, so the hash difference between the two conditions means exactly "one
 * tool fewer" and not "a reworded prompt".
 */
export const WIKI_TOOL_BULLET =
  "\n- search_reference: full-text search over a game reference wiki (quests, NPCs, zones, items). Use it when you need world knowledge such as where a questgiver stands or what an objective means. Whether results carry wiki-recorded coordinates is stated in the tool's own description for this run; when they do, they are reference notes, not live observation, and do not prove anything is at that spot now.";

export const TOOLS_NOT_AMBIENT = {
  withWiki:
    "Tools and ambient objects are different things and do not mix: the tools below (run_snippet, search_reference, write_scratchpad, reflect, log_status, read_log, …) are called by you between snippets, and are not defined inside a snippet — write_scratchpad(...) or search_reference(...) in snippet code is a ReferenceError. Inside a snippet the equivalent is the ambient object: await scratchpad.read() and await scratchpad.write(text) for the notes; the reference wiki has no snippet-side equivalent, so search it with the tool.",
  withoutWiki:
    "Tools and ambient objects are different things and do not mix: the tools below (run_snippet, write_scratchpad, reflect, log_status, read_log, …) are called by you between snippets, and are not defined inside a snippet — write_scratchpad(...) or log_status(...) in snippet code is a ReferenceError. Inside a snippet the equivalent is the ambient object: await scratchpad.read() and await scratchpad.write(text) for the notes.",
} as const;

/**
 * The body for one harness: the fixed text with that harness's snippet-delta
 * and context sentences in it, and — with `wiki: false` — without the
 * reference tool.
 */
function bodyFor(harness: Harness, wiki = true, program?: ProgramPrompt): string {
  // The wiki-on rendering is `BODY_HEAD` untouched, by construction rather
  // than by test: `wiki: false` is two exact deletions from it and nothing
  // else, so every run that has the reference surface hashes as it always did.
  // The program loop's body is built from it by exact replacements
  // (`programBodyHead`), so the same two deletions apply to it.
  const base = program === undefined ? BODY_HEAD : programBodyHead(program);
  const head = wiki
    ? base
    : base.replace(WIKI_TOOL_BULLET, "").replace(TOOLS_NOT_AMBIENT.withWiki, TOOLS_NOT_AMBIENT.withoutWiki);
  const tail = program === undefined ? BODY_TAIL : program.yield ? `${PROGRAM_BODY_TAIL} ${PROGRAM_YIELD_TAIL}` : PROGRAM_BODY_TAIL;
  return `${head}${snippetDeltaClause(harness)} ${contextSentence(harness)} ${tail}`;
}

// ------------------------------------------------------------ program loop

/**
 * The program loop's prompt (`loop: "program"`; wording approved by the
 * operator, 2026-11-12). It is a second
 * body beside the snippet loop's, never an edit of it: each passage that
 * describes the snippet loop's persistent REPL is replaced exactly
 * (`replaceExactly`, which throws at load when a target is missing or
 * repeated), so every other byte — the SDK, the state shapes, the other tools
 * — is the same on both loops, and the snippet loop's prompt is untouched.
 * `yield` adds one tool bullet and one closing sentence.
 */
export interface ProgramPrompt {
  /** The `yield` tool is served (`RunConfig.yield`). */
  yield: boolean;
}

/** The program prompt a run renders, or undefined on the snippet loop. */
export function programPromptOf(config: Pick<RunConfig, "loop" | "yield">): ProgramPrompt | undefined {
  return config.loop === "program" ? { yield: config.yield === true } : undefined;
}

/** `text` with `from` replaced by `to`; throws unless `from` occurs exactly once. */
function replaceExactly(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at === -1 || text.indexOf(from, at + from.length) !== -1) {
    throw new Error(`prompt.ts: a program-loop replacement target is not in the snippet body exactly once: ${from.slice(0, 80)}…`);
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** The opening's runtime paragraph on the program loop. */
export const PROGRAM_RUNTIME_LEAD =
  "You do not play directly. You write TypeScript that runs in a sandbox holding one SDK client for your game session — snippets, which run once, and routines, functions in your own files that the harness keeps running — and you supervise the results.";

const PROGRAM_SECTIONS = `## Your program

Your workspace is a small directory of files that outlives the sandbox; read_file, write_file, edit_file and delete_file are how you change it. main.ts at its root is your program, and it imports your other files by relative path (import { pickTarget } from "./lib/combat").

Every async function main.ts exports is a routine, named by its export:

export async function grind(args) { while (!signal.aborted) { … } }

An async function in another file is a routine only once main.ts exports it (export { patrol } from "./lib/patrol"), and every file, main.ts included, holds at most 32,000 characters.

start_routine({ name: "grind", args: { … } }) runs it, and the harness keeps it running, whether you are awake or not, until it returns, throws or you stop it with stop_routine({ name: "grind" }). A routine has no time limit; a loop is a while you write. Stopping a routine aborts its signal, so its pending sdk waits reject with EventAbortedError and a move it has in flight is stopped. A name that is already running is not started twice: the refusal says since when.

A save loads at once: a write_file, edit_file or delete_file that changes main.ts or a file it imports loads your program afresh, and the tool's result says so. A program that fails to load (a syntax error, an import of a file not written yet) changes nothing: the result carries the error and the code already running keeps running. When a load succeeds, every running routine is stopped and started again from the top with the same arguments. Variables in your files start over at every load; memory does not.

## Snippets

run_snippet runs TypeScript once, now: to act once, to look at the world, or to try a function from your files, which a snippet imports as main.ts does (import { pickTarget } from "./lib/combat"). await works at the top level. A single-expression snippet returns its value, REPL-style; otherwise use return or console.log to see results. Nothing a snippet declares or starts outlives it: its bindings, timers and event listeners end when it returns, so what must keep running is a routine, and what must be remembered goes in memory or the scratchpad. Routines and snippets see the same ambient names:`;

const PROGRAM_TOOL_BULLETS = `- run_snippet: run TypeScript once, now, in the sandbox. Nothing it starts outlives it.
- read_file / write_file / edit_file / delete_file: your workspace files. write_file creates a file or replaces its whole content; edit_file({ path, old, new }) changes one part in place under edit_scratchpad's rules (old matches exactly and once, or pass replaceAll); delete_file removes one. Each file holds at most 32,000 characters and the workspace 1 MiB; a change past a limit is refused and saves nothing. No file is shown to you unless you read it; the scratchpad is unchanged.
- start_routine / stop_routine: start_routine({ name, args? }) runs an exported function of main.ts as a routine, passing args as its one argument; stop_routine({ name }) stops it. Each answers with the state of every routine.`;

/** The `yield` tool's bullet, after the routine tools' (`yield` only). */
const PROGRAM_YIELD_BULLET =
  "\n- yield: sleep until something wakes you. yield({ seconds? }) returns when a wake arrives, or after seconds (at most 300, the default), and its result is the [wake] block and any harness notices since your last turn message.";

/** Each passage of the snippet body the program body replaces, and with what. */
function programReplacements(program: ProgramPrompt): readonly [string, string][] {
  return [
    [
      "## The snippet runtime\n\nSnippets run in one long-lived process. Top-level const/let/var/function/class declarations persist across snippets (destructured declarations may not persist; prefer simple names or assign to globalThis). Background routines persist too: a setInterval, or an async function you call without awaiting, keeps running between snippets and after the snippet that started it returns — so work longer than one snippet's time limit belongs in one, and you stop it from a later snippet. await works at the top level. A single-expression snippet returns its value, REPL-style; otherwise use return or console.log to see results. import is not available — everything you need is ambient:",
      PROGRAM_SECTIONS,
    ],
    ["safe to compose, including from a background routine.", "safe to compose, including from a routine."],
    [
      "- signal: this snippet's AbortSignal. Aborted when the snippet is abandoned; check signal.aborted in long loops, or pass it to your own timers.",
      "- signal: this snippet's or this routine's AbortSignal. A snippet's is aborted when it returns or is abandoned, a routine's when it is stopped or restarted; check signal.aborted in long loops, or pass it to your own timers.\n" +
        '- memory: one plain JSON object the harness keeps for you, saved as memory.json in your workspace. Assign to it (memory.phase = "grind"): it is saved as your code runs and loaded again when the sandbox restarts. It holds at most 32,000 characters of JSON and only plain values — no Map, no BigInt, no cycles. read_file shows it; only your code changes it.\n' +
        '- wake(reason): ask for your own attention from a routine, e.g. wake("bags full"). It wakes you if you are asleep, and the next wake lists it either way.',
    ],
    [
      'bindings and routines started by earlier snippets are untouched. A long walk is the usual way to hit that limit (on foot roughly 200y; less swimming, more mounted), so dispatch those with await sdk.moveToAsync(target), or from a background routine, and poll state.self.position or the WB_MOVE_RESULT event instead of awaiting sdk.moveTo inline. A single-expression snippet that evaluates to a promise waits for that promise, so launch a background routine as a statement followed by a value (globalThis.trip = (async () => { … })().catch(String); "started"). A snippet that blocks the event loop gets the whole sandbox killed and restarted, losing all bindings and routines — you will be told when that happens.',
      "your routines are untouched. A long walk is the usual way to hit that limit (on foot roughly 200y; less swimming, more mounted), so a long walk belongs in a routine, where await sdk.moveTo(target) has no limit to hit. Each character has one move at a time and the newest wins: a move from a snippet replaces the move a routine has in flight, the routine's call answers superseded, and both are told which replaced which. Code that blocks the event loop — a synchronous loop that never awaits — gets the whole sandbox killed and restarted. Your files, memory and scratchpad survive it and your routines are started again from the top; when a routine was what blocked, none is restarted and you are told which were running.",
    ],
    [
      "- run_snippet: execute TypeScript in the sandbox. Your only way to act.",
      program.yield ? `${PROGRAM_TOOL_BULLETS}${PROGRAM_YIELD_BULLET}` : PROGRAM_TOOL_BULLETS,
    ],
    [
      "There is no read tool: every turn's context already carries the scratchpad as last written, and inside a snippet await scratchpad.read() returns it.",
      "There is no read tool: the scratchpad as last written is in this turn's context or earlier in this conversation, and inside a snippet await scratchpad.read() returns it.",
    ],
    [
      "## Each turn\n\nEvery turn you receive the current state summary, the most recent events, any harness notices, and your scratchpad.",
      "## Each turn\n\nEvery turn you receive the current state summary, the most recent events, any harness notices, and your scratchpad, or a line saying it is unchanged since you last saw it in this conversation. After you have slept, the turn begins with a [wake] block: why you were woken and what your routines did meanwhile — each routine's state and how long ago it last acted, new errors with the lines of your files they came from, refusals with their hints, moves that replaced one another, what changed for your character, and the last lines your routines printed.",
    ],
  ];
}

function programBodyHead(program: ProgramPrompt): string {
  return programReplacements(program).reduce((text, [from, to]) => replaceExactly(text, from, to), BODY_HEAD);
}

/** The last sentences of the program prompt: what a reply with no tool call does, and what wakes the model. */
export const PROGRAM_BODY_TAIL =
  "Text without a tool call does nothing in the world. A reply with no tool call puts you to sleep while your routines keep running. You are woken when a routine ends, by the first occurrence of each new error or refusal in your routines, by a wake(reason) call, a death, a sandbox restart or a harness notice, and after five minutes at the latest. Gaining a level or completing a quest does not wake you; the next wake reports it.";

/** The sentence `yield` adds after `PROGRAM_BODY_TAIL`. */
export const PROGRAM_YIELD_TAIL = "yield sleeps the same way and returns the wake as its result.";

/** The opening sections on the program loop: the runtime paragraph replaced, everything else as it reads. */
const PROGRAM_GOAL_SECTION = replaceExactly(GOAL_SECTION, RUNTIME_LEAD, PROGRAM_RUNTIME_LEAD);
const PROGRAM_WORLD_SECTION = replaceExactly(WORLD_SECTION, RUNTIME_LEAD, PROGRAM_RUNTIME_LEAD);

/**
 * The one sentence a harness whose driver takes the snippet delta adds
 * (`DriverEntry.snippetDelta`, drivers.ts; claude-code only, operator
 * 2026-10-21), right after the sentence saying what every turn carries; empty
 * everywhere else, so every other rendering keeps its bytes. A statement of
 * what the result carries, nothing about what to do with it.
 */
export const SNIPPET_DELTA_SENTENCE =
  "Each snippet result ends with what changed since your previous snippet (party, chat, damage taken, level and quests), when anything did.";

function snippetDeltaClause(harness: Harness): string {
  return harnessDriver(harness)?.snippetDelta === true ? ` ${SNIPPET_DELTA_SENTENCE}` : "";
}

/**
 * The fixed system prompt on the fixed loop, exactly as it has always read:
 * goal, then body. Defined as the join of the halves so that "no objective" is
 * byte-identical to the old single string by construction, not by test.
 */
export const SYSTEM_PROMPT = `${GOAL_SECTION}\n\n${bodyFor("wrathbench")}`;

/**
 * The same prompt as the claude-code harness renders it. Differs from
 * `SYSTEM_PROMPT` in `contextSentence` and the snippet-delta sentence and
 * nothing else, so the two hash differently in the comparability tuple —
 * which is the intended, visible record that the two harnesses do not share a
 * prompt.
 */
export const CLAUDE_CODE_SYSTEM_PROMPT = `${GOAL_SECTION}\n\n${bodyFor("claude-code")}`;

/**
 * The same prompt as the codex harness renders it: `CLAUDE_CODE_SYSTEM_PROMPT`
 * less the snippet-delta sentence, by construction (`contextSentence`,
 * `snippetDeltaClause`). The CLI scaffolds run the same conversation regime,
 * so the prompt says the same thing about it; codex takes no snippet delta
 * yet (operator, 2026-10-21), so it is not told of one.
 */
export const CODEX_SYSTEM_PROMPT = `${GOAL_SECTION}\n\n${bodyFor("codex")}`;

/**
 * The same prompt as the pi harness renders it, byte-identical to the codex
 * render by construction: pi keeps one continuous session and compacts it
 * itself, the regime the CLI sentence states, so it adds no wording of its own
 * (the operator's to confirm, #257), and like codex it takes no snippet delta
 * yet. pi receives exactly these bytes as its system prompt (`adapter-pi.ts`,
 * `PI_PROMPT_EXTENSION`).
 */
export const PI_SYSTEM_PROMPT = `${GOAL_SECTION}\n\n${bodyFor("pi")}`;

/**
 * The delimited block an operator objective is rendered into. One shape, one
 * place, verbatim text: the prompt a model sees for a given objective does not
 * depend on which model or which driver it is. The objective replaces the
 * broad goal for its run rather than adding to it (operator, 2026-10-21): a
 * Deadmines party told it was "in addition to the standing goal" left the
 * dungeon after some wipes to level in Westfall, which the goal endorsed.
 */
export function objectiveSection(objective: string): string {
  return `--- Operator objective for this run ---\n${objective}\n--- end operator objective ---`;
}

/**
 * What the episode tier tells the model about itself (docs/EPISODES.md).
 * Facts a player has — the clock and the rule — not an objective: the goal and
 * the scoring are unchanged. Identical for every model; it varies only with
 * `episode`, which the comparability tuple already carries. The steered tiers
 * (`freeplay`, `probing`) have no fixed clock: a probe states its own budget
 * when it carries an objective (`probingClockSentence`), and freeplay states
 * none.
 *
 * Each eval states its clock and nothing else (operator, 2026-11-14). The e90
 * sentence used to name the promotion bar, level 5 for six-hour episodes, and
 * then that the bar did not end the episode, because three Sonnet 5.5 runs read
 * the bar as a finish line and idled into the no-XP watchdog. Promotion is a
 * stopping rule of the scheduler's, and a stopping rule the model is told about
 * becomes part of what is measured, so both sentences went: the tiers and the
 * bar can now change without moving a prompt hash.
 */
export function episodeSection(episode: EpisodeId | undefined): string | undefined {
  if (episode === undefined) return undefined;
  // Exhaustive over `EpisodeId` on purpose: a `default` arm made a new tier
  // silently arrive with no self-description at all, which is a change to what
  // the model is told and must never happen by omission.
  switch (episode) {
    case "e90":
      return "This episode lasts 90 minutes.";
    case "e360":
      return "This episode lasts six hours.";
    case "probing":
    case "freeplay":
      // Both are steered tiers whose clock is set per run, so the tier itself
      // names none: a sentence naming a default the run may not be under would
      // be a false fact rather than a missing one.
      return undefined;
    case "deadmines":
    case "deadmines-solo":
      // A task episode states its clock in the words a probe with an objective
      // does, so its prompt is byte for byte the one its rehearsal ran on
      // (deadmines@5's one-agent arm, @4's members).
      return probingClockSentence(EPISODES[episode].minutes * 60_000);
  }
}

/**
 * The text a run's prompt renders in the objective's block: an operator
 * objective, or a task episode's directive (`RunConfig.directive`), which
 * reads the same and is not one. A config carries at most one of the two.
 */
export function steeringOf(config: { objective?: string | undefined; directive?: string | undefined }): string | undefined {
  return config.objective ?? config.directive;
}

const HOUR_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/**
 * A budget in the words the eval clock sentences use: whole hours spelled out
 * ("six hours", "four hours", "one hour") up to twelve, anything else in
 * minutes as a numeral ("90 minutes").
 */
export function clockWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes > 0 && minutes % 60 === 0) {
    const hours = minutes / 60;
    const n = hours <= HOUR_WORDS.length ? HOUR_WORDS[hours - 1]! : String(hours);
    return hours === 1 ? `${n} hour` : `${n} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The clock a probe states, from its own budget (`watchdogs.episodeMs`): the
 * Deadmines party, told nothing, did not know its run lasted four hours. Said
 * only on a probe that carries an objective, so every probe without one — the
 * race and class sweeps, the compaction-window campaigns — keeps the prompt it
 * has always hashed under; a budget with no episode limit states no clock.
 */
export function probingClockSentence(episodeMs: number | null | undefined): string | undefined {
  if (episodeMs === null || episodeMs === undefined || episodeMs <= 0) return undefined;
  return `This run lasts ${clockWords(episodeMs)}.`;
}

/**
 * The system prompt for a run. With no objective, no episode and the default
 * harness this returns `SYSTEM_PROMPT` unchanged, and with no objective any
 * episode adds only its tier sentence after the standing goal, so every run
 * without an objective reads exactly as it always has.
 *
 * An objective replaces the broad goal (operator, 2026-10-21): the opening
 * keeps its world facts and drops the directive sentences (`WORLD_SECTION`),
 * then come the tier sentence — on a probe, the clock from `episodeMs` — and
 * the delimited objective block, then the body. The facts still read first.
 *
 * `harness` picks the context sentence and the snippet-delta sentence and
 * nothing else, so the fixed loop's prompt and a CLI scaffold's differ by
 * exactly the sentences that describe what each of them actually does with
 * older conversation and with a snippet's result. `wiki`
 * is the run's reference surface (`config.wiki`, issue #61): false renders the
 * body with `search_reference` deleted, which is the only way the prompt ever
 * differs on that axis. `episodeMs` is the run's budget
 * (`config.watchdogs.episodeMs`); only a probe with an objective reads it.
 */
export function buildSystemPrompt(
  objective?: string | undefined,
  episode?: EpisodeId | undefined,
  harness: Harness = "wrathbench",
  wiki = true,
  episodeMs: number | null = null,
  /** The program loop's prompt (`programPromptOf`); undefined is the snippet loop, this prompt as it always was. */
  program?: ProgramPrompt,
): string {
  const steered = objective !== undefined && objective.trim().length > 0;
  const parts = program === undefined ? [steered ? WORLD_SECTION : GOAL_SECTION] : [steered ? PROGRAM_WORLD_SECTION : PROGRAM_GOAL_SECTION];
  const tier = steered && episode === "probing" ? probingClockSentence(episodeMs) : episodeSection(episode);
  if (tier !== undefined) parts.push(tier);
  if (steered) parts.push(objectiveSection(objective.trim()));
  parts.push(bodyFor(harness, wiki, program));
  return parts.join("\n\n");
}

/**
 * The launch session note for a fresh episode: what the model is told about
 * the character it is about to create.
 *
 * The NAME is the model's own, and nothing but the model's — a name it chose
 * is one it may feel some ownership of, and fixed per-model names collided
 * across accounts the moment fresh attempts stopped returning to the account
 * their predecessor used. No name travels with the launch any more, not even
 * as a suggestion: a suggestion is a name the harness has to invent, keep
 * valid and keep unique, and an invalid one took a whole fleet config down on
 * 2026-08-25. The race and class are NOT the model's: they are the episode's comparability dimensions
 * and every run is read against them.
 *
 * `taken` are the names episode hygiene could not clear off the account.
 * `createSession` reuses an existing character of the name it is given, so a
 * model that picked one of these would land on a used character and burn the
 * attempt as `stale-character` — hence they are named, not left to be
 * discovered.
 */
export function freshCharacterNote(o: { race: number; class: number; taken?: readonly string[] }): string {
  const taken = o.taken ?? [];
  return (
    `name your character: 2-12 letters, no spaces, no three identical letters in a row — ` +
    `pick something you like and be creative, it is yours for the episode. ` +
    `Your race and class are not yours to choose: ` +
    `race ${o.race}, class ${o.class} (numeric ids; e.g. race 1 = Human, class 2 = Paladin) are ` +
    `this episode's fixed dimensions and every run is compared on them. Create the character with ` +
    `\`await sdk.createSession({ character: "<your name>", race: ${o.race}, class: ${o.class} })\` ` +
    `after \`await connect()\` — the name is required, so supply one. If the server answers ` +
    `\`char_create_failed_code_50\` the name is already in use: pick a different one and call ` +
    `createSession again.` +
    (taken.length > 0
      ? ` These names are already taken on this account and must not be used: ${taken.join(", ")}.`
      : "") +
    ` The game account is assigned and bound for you by the harness — do not pass an account; ` +
    `createSession is issued on the correct one automatically.`
  );
}

/**
 * The staged-character launch note: a run launched on a character the
 * operator's stager made before it (`--character`, a party member). The
 * sibling of `freshCharacterNote` for that one start, in the words the
 * operator approved (docs/proposals/GROUP-PLAY.md §8, 2026-10-19). The level
 * is the staging's own (`start.level` of the campaign definition), said only
 * when known; race and class are the client's names for the ids.
 */
export function stagedCharacterNote(o: { character: string; level: number | undefined; raceName: string; className: string }): string {
  const level = o.level !== undefined ? `level ${o.level} ` : "";
  return (
    `Your character already exists: ${o.character}, a ${level}${o.raceName} ${o.className}. ` +
    `Log in with \`await sdk.createSession({ character: "${o.character}" })\`. Do not create another character.`
  );
}

/**
 * The resumed run's session note: what a model with no conversation history is
 * told about the character it already has.
 *
 * It carries the same character facts the fresh-launch note does, and for the
 * same reason: anything the note leaves out the model has to guess.
 * `nav-probe-freeplay-sonnet-20260823-c3` guessed — the old note said
 * `createSession({...})` with no name — and rolled a second, wrong character
 * next to the one the pause had preserved, which is exactly the loss
 * pause-and-resume exists to prevent.
 *
 * `character` is the name the run RECORDED (`trajectory.setCharacter`). A run
 * that paused before `createSession` ever landed has none, and there is
 * nothing to preserve or reuse: it gets the fresh-launch note instead of one
 * that interpolates a name it does not have.
 */
/**
 * The continued run's session note: a freeplay character coming back under a new
 * run id — the operator disabled it, or the character's previous run ended — on
 * the character and scratchpad its predecessor left. The same character facts
 * the resume note carries, for the same reason, and the same instruction:
 * `createSession` on the recorded name reuses the character, so the model
 * must not roll another one.
 */
export function continuedSessionNote(o: {
  character: string;
  race: number;
  class: number;
  /** The run id being continued. */
  from: string;
  /** The last observed level/xp sentence, or "" when nothing was observed. */
  seen: string;
  raceName?: string | null;
  className?: string | null;
  /**
   * The run is on the program loop: what it carried is said in that loop's
   * words, `true` when the predecessor's files came along
   * (`PROGRAM_CONTINUE_KEPT`), `false` when there were none to carry
   * (`PROGRAM_CONTINUE_EMPTY`).
   */
  programFiles?: boolean | undefined;
}): string {
  const race = o.raceName ?? null;
  const klass = o.className ?? null;
  const kept = o.programFiles === undefined ? "Conversation history was not preserved; your scratchpad was." : o.programFiles ? PROGRAM_CONTINUE_KEPT : PROGRAM_CONTINUE_EMPTY;
  return (
    `this session continues your earlier freeplay session ${o.from} on the same character. ` +
    `${kept} ` +
    `Your character is unchanged and was NOT deleted: name "${o.character}", ` +
    `race ${o.race}${race !== null ? ` (${race})` : ""}, class ${o.class}` +
    `${klass !== null ? ` (${klass})` : ""}.${o.seen} Do not create a different one. ` +
    `Run \`await connect()\`, then ` +
    `\`await sdk.createSession({ character: "${o.character}", race: ${o.race}, class: ${o.class} })\` ` +
    `— it reuses the existing character of that name.`
  );
}

/**
 * What a continued program-loop run carried from its predecessor (operator,
 * 2026-11-14), in place of the snippet loop's "Conversation history was not
 * preserved; your scratchpad was.": its files and memory, and none of its
 * routines running. A draft for the operator's review.
 */
export const PROGRAM_CONTINUE_KEPT =
  "Conversation history was not preserved; your scratchpad, your files and memory were, and no routine is running: start the ones you want.";

/** The same, when the predecessor left no files (it ran the snippet loop, or wrote none). A draft for the operator's review. */
export const PROGRAM_CONTINUE_EMPTY = "Conversation history was not preserved; your scratchpad was, and your files start empty.";

/**
 * What a resumed program-loop run kept, in place of the snippet loop's
 * "Conversation history was not preserved; your scratchpad was." A draft
 * for the operator's review (the approved prompt left it to the runner).
 */
export const PROGRAM_RESUME_KEPT =
  "Conversation history was not preserved; your scratchpad, your files and memory were, and the routines that were running are started again from the top.";

export function resumeSessionNote(o: {
  character: string | undefined;
  race: number;
  class: number;
  /** e.g. "40 minutes elapsed of 90". */
  clock: string;
  /** The last observed level/xp sentence, or "" when nothing was observed. */
  seen: string;
  raceName?: string | null;
  className?: string | null;
  /** The run is on the program loop: what it kept is said in that loop's words (`PROGRAM_RESUME_KEPT`). */
  program?: boolean | undefined;
}): string {
  const head =
    `the runner process was restarted and this run resumed after a pause, ${o.clock}. ` +
    (o.program === true ? `${PROGRAM_RESUME_KEPT} ` : `Conversation history was not preserved; your scratchpad was. `);
  if (o.character === undefined) {
    return head + freshCharacterNote({ race: o.race, class: o.class });
  }
  const race = o.raceName ?? null;
  const klass = o.className ?? null;
  return (
    head +
    `Your character for this episode is unchanged and was NOT deleted: name "${o.character}", ` +
    `race ${o.race}${race !== null ? ` (${race})` : ""}, class ${o.class}` +
    `${klass !== null ? ` (${klass})` : ""}.${o.seen} Do not create a different one. ` +
    `Run \`await connect()\`, then ` +
    `\`await sdk.createSession({ character: "${o.character}", race: ${o.race}, class: ${o.class} })\` ` +
    `— it reuses the existing character of that name; a \`token_in_use\` error means the session is ` +
    `still alive and you can simply keep acting through \`sdk\`.`
  );
}
