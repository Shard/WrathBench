/**
 * The scripted reference program: one tick of play, as a snippet runs it.
 *
 * `referenceTick` is sent to the sandbox as source text (`Function.prototype
 * .toString`, `adapter.ts`) and evaluated there exactly as a model's snippet
 * is: the same child, the same SDK client and session, the same contracts and
 * the same `snippetTimeoutMs`. It therefore must be **self-contained** — it
 * may use only its parameters and JavaScript built-ins, never anything else
 * this module or another one defines at the top level. `reference.test.ts`
 * evaluates the serialised text in a scope with nothing else in it, which is
 * what holds that line. Types are fine: they are erased before the text exists.
 *
 * What it may touch is the ambient snippet surface and nothing more: `sdk`,
 * `state`, `connect()`, `sleep()`, `scratchpad`. Every decision is made from
 * what the state cache observed — the quest log, the units in view, our own
 * health and position — and every act is an SDK call a model could make.
 *
 * One tick does at most one thing worth waiting for (a walk leg, a fight, a
 * turn-in), inside `budgetMs`, and reports. The adapter decides nothing but
 * whether to stay on the step or advance; everything about the world is
 * decided here, from the world, every tick, so a tick replayed after a sandbox
 * restart or a resume finds the work already done and moves on.
 */

import type { StateCache, UnitView, WrathClient } from "@wrathbench/sdk";
import type { GatedStep, Point, Route } from "./route";

/** The ambient snippet surface the program is handed (runner/src/sandbox/entry.ts). */
export interface ReferenceEnv {
  sdk: WrathClient;
  state: StateCache;
  connect: () => Promise<unknown>;
  sleep: (ms: number, options?: { wake?: boolean }) => Promise<string>;
  scratchpad: { read: () => Promise<unknown>; write: (content: string) => Promise<unknown> };
  /** Memory across ticks, held on the sandbox's global; lost on a restart, and nothing depends on it surviving. */
  mem: Record<string, unknown>;
}

export interface TickArgs {
  /** The route step the adapter is on. */
  cursor: number;
  /** Wall-clock ms this tick may spend before it must return. */
  budgetMs: number;
  race: number;
  class: number;
}

/** What one tick says back. Small: it rides one console line of the snippet result. */
export interface TickReport {
  v: 1;
  cursor: number;
  /** The step is done (or does not apply); the adapter moves to the next. */
  advance: boolean;
  /** What the tick did, in a few words each. */
  did: string[];
  level?: number;
  xp?: number;
  hp?: number;
  /** The cursor the scratchpad held at login: where a resumed or restarted run picks up. */
  restored?: number;
  /** The tick had no session and logged in (or tried to). */
  login?: boolean;
}

export async function referenceTick(env: ReferenceEnv, route: Route, args: TickArgs): Promise<TickReport> {
  const { sdk, state, connect, sleep, scratchpad, mem } = env;
  const deadline = Date.now() + args.budgetMs;
  const left = (): number => deadline - Date.now();
  const did: string[] = [];
  const say = (s: string): void => {
    did.push(s.length > 160 ? `${s.slice(0, 157)}...` : s);
  };

  const levelOf = (): number => state.self.level?.value ?? 1;
  const hpPct = (): number | undefined => {
    const h = state.self.health?.value;
    return h === undefined || h.max <= 0 ? undefined : Math.round((h.current / h.max) * 100);
  };
  const report = (advance: boolean, extra: Partial<TickReport> = {}): TickReport => {
    const xp = state.xp?.value;
    const hp = hpPct();
    return {
      v: 1,
      cursor: args.cursor,
      advance,
      did,
      level: levelOf(),
      ...(xp !== undefined ? { xp } : {}),
      ...(hp !== undefined ? { hp } : {}),
      ...extra,
    };
  };
  const msg = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  const here = (): Point | undefined => {
    const p = state.self.position?.value;
    return p === undefined ? undefined : { x: p.x, y: p.y, z: p.z };
  };
  const dist = (a: Point, b: { x?: number | undefined; y?: number | undefined }): number =>
    b.x === undefined || b.y === undefined ? Infinity : Math.hypot(a.x - b.x, a.y - b.y);

  // ------------------------------------------------------------ the pad
  /** The run's own notes: the character's name and the step reached, so a restart or a resume picks up. */
  const PAD_NAME = /reference-character: ([A-Za-z]{2,12})/;
  const PAD_CURSOR = /reference-cursor: (\d+)/;
  const readPad = async (): Promise<string> => {
    try {
      const v = await scratchpad.read();
      return typeof v === "string" ? v : "";
    } catch {
      return "";
    }
  };
  const writePad = async (name: string, cursor: number): Promise<void> => {
    try {
      await scratchpad.write(`reference-character: ${name}\nreference-cursor: ${cursor}\n`);
    } catch (err) {
      say(`scratchpad write refused: ${msg(err)}`);
    }
  };

  // ------------------------------------------------------------ session
  if (sdk.selfKey === undefined || state.self.position === undefined) {
    await connect();
    const pad = await readPad();
    const saved = PAD_NAME.exec(pad)?.[1];
    const restoredRaw = PAD_CURSOR.exec(pad)?.[1];
    const restored = restoredRaw === undefined ? undefined : Number(restoredRaw);
    // A fresh name the game's rules accept: alternating consonants and vowels
    // never put three identical letters in a row.
    const fresh = (): string => {
      const c = "bdfghklmnprstvz";
      const v = "aeiou";
      let s = "";
      const len = 6 + Math.floor(Math.random() * 3);
      for (let i = 0; i < len; i++) {
        const set = i % 2 === 0 ? c : v;
        s += set[Math.floor(Math.random() * set.length)];
      }
      return s[0]!.toUpperCase() + s.slice(1);
    };
    const name = saved ?? (typeof mem["name"] === "string" ? (mem["name"] as string) : fresh());
    try {
      const r = await sdk.createSession({ character: name, race: args.race, class: args.class });
      mem["name"] = name;
      await writePad(name, restored ?? args.cursor);
      say(`in world as ${name} (${r.inWorld === true ? "in world" : "session answered"})`);
    } catch (err) {
      // A name another account holds, or a refused create: a new name next tick
      // unless this one was already the run's.
      if (saved === undefined) delete mem["name"];
      say(`createSession as ${name} failed: ${msg(err)}`);
      return report(false, { login: true });
    }
    return report(false, { login: true, ...(restored !== undefined ? { restored } : {}) });
  }
  const name = typeof mem["name"] === "string" ? (mem["name"] as string) : (state.self.name ?? "");

  // ------------------------------------------------------------ movement
  /**
   * One leg toward a point: at most ~110y, so the walk fits the tick. Returns
   * true once within `near` yards. A point off the mesh is retried at the
   * nearest walkable point the refusal names; a ledge is taken (the program
   * does not climb down cliffs on purpose, and the fall is the server's to
   * charge); anything else is reported and counted, and the caller decides.
   */
  const walk = async (to: Point, near = 4): Promise<boolean> => {
    const me = here();
    if (me === undefined) return false;
    const d = dist(me, to);
    if (d <= near) return true;
    const LEG = 110;
    const f = Math.min(1, LEG / d);
    const leg = f >= 1 ? to : { x: me.x + (to.x - me.x) * f, y: me.y + (to.y - me.y) * f, z: me.z + (to.z - me.z) * f };
    const timeout = Math.max(1_500, left() - 1_500);
    try {
      let r = await sdk.moveTo(leg, { timeout });
      if (!r.ok && r.status === "target_off_mesh" && r.nearest != null) r = await sdk.moveTo(r.nearest, { timeout: Math.max(1_500, left() - 1_500) });
      if (!r.ok && r.status === "drop") r = await sdk.moveTo(leg, { timeout: Math.max(1_500, left() - 1_500), force: true });
      if (!r.ok) {
        mem["moveFailures"] = Number(mem["moveFailures"] ?? 0) + 1;
        say(`move ${r.status}`);
        return false;
      }
      mem["moveFailures"] = 0;
    } catch (err) {
      // Out of tick: the walk goes on and the next tick picks it up.
      say(`walking (${msg(err).slice(0, 60)})`);
      return false;
    }
    const after = here();
    return after !== undefined && dist(after, to) <= near;
  };

  // ------------------------------------------------------------ combat
  const best = (family: readonly number[]): number | undefined => {
    for (let i = family.length - 1; i >= 0; i--) if (state.spell(family[i]!) !== undefined) return family[i];
    return undefined;
  };
  const selfKey = sdk.selfKey;
  const buffUp = async (): Promise<void> => {
    const on = new Set(state.aurasOf(selfKey).map((a) => a.spellId));
    for (const family of route.buffs) {
      if (family.some((id) => on.has(id))) continue;
      const id = best(family);
      if (id === undefined) continue;
      try {
        await sdk.castSpell(id, selfKey);
        await sleep(1_600, { wake: false });
        say(`buff ${id}`);
      } catch (err) {
        say(`buff ${id} refused: ${msg(err).slice(0, 60)}`);
      }
    }
  };
  const heal = async (): Promise<boolean> => {
    const id = best(route.heal);
    const mana = state.self.power?.value;
    if (id === undefined || mana === undefined || mana.max <= 0 || mana.current / mana.max < 0.25) return false;
    try {
      await sdk.castSpell(id, selfKey);
      await sleep(3_000, { wake: false });
      say(`heal ${id}`);
      return true;
    } catch {
      return false;
    }
  };
  /** Fight one unit to its end or the tick's, then loot it. */
  const fight = async (u: UnitView): Promise<"killed" | "open" | "died"> => {
    await buffUp();
    const healable = best(route.heal) !== undefined;
    const r = await sdk.killTarget(u, {
      timeout: Math.max(2_000, left() - 9_000),
      ...(healable ? { abortBelowHealthPct: 30 } : {}),
    });
    say(`fight ${u.entry ?? "?"}: ${r.status}`);
    if (r.status === "player_died") return "died";
    if (r.status === "aborted_low_health") {
      await heal();
      return "open";
    }
    if (r.status !== "killed") return "open";
    await sleep(700, { wake: false });
    if (left() > 3_000) {
      try {
        const loot = await sdk.lootCorpse(u.guid, { timeout: Math.min(8_000, Math.max(1_000, left() - 1_000)) });
        if (loot.ok) say(`looted ${loot.items.length} item(s)${loot.gold > 0 ? `, ${loot.gold}c` : ""}`);
        else if (loot.status === "none_stored") mem["bagsFull"] = true;
      } catch (err) {
        say(`loot: ${msg(err).slice(0, 60)}`);
      }
    }
    return "killed";
  };
  /** What in view is fighting us now. */
  const attackers = (): UnitView[] =>
    state.units({ type: "unit", alive: true, maxDistance: 40 }).filter((u) => u.targetGuid !== undefined && u.targetGuid === selfKey && u.roles.length === 0);
  /** Hunt one of these entries in view, else walk the patrol. */
  const hunt = async (entries: readonly number[], areas: readonly Point[], maxLevel: number): Promise<void> => {
    const prey = entries.length === 0
      ? undefined
      : state
          .units({ entry: [...entries], type: "unit", alive: true, maxDistance: 70 })
          .find((u) => (u.level === undefined || u.level <= maxLevel) && (u.targetGuid === undefined || u.targetGuid === selfKey));
    if (prey !== undefined) {
      await fight(prey);
      return;
    }
    if (areas.length === 0) return;
    const i = Number(mem["patrol"] ?? 0) % areas.length;
    if (await walk(areas[i]!, 12)) mem["patrol"] = i + 1;
    else if (Number(mem["moveFailures"] ?? 0) >= 3) {
      mem["patrol"] = i + 1;
      mem["moveFailures"] = 0;
    }
  };

  // ------------------------------------------------------------ dead
  const ghost = state.self.ghost?.value === true;
  const hp = state.self.health?.value;
  if (!ghost && hp !== undefined && hp.current === 0) {
    try {
      await sdk.repop();
      say("released");
    } catch (err) {
      say(`repop: ${msg(err).slice(0, 60)}`);
    }
    await sleep(2_000, { wake: false });
    return report(false);
  }
  if (ghost) {
    const corpse = state.self.corpse?.value;
    const me = here();
    if (corpse === undefined) {
      const healer = state.closest({ role: "spiritHealer" });
      if (healer !== undefined) {
        if ((healer.distance ?? Infinity) > 5) await walk({ x: healer.x!, y: healer.y!, z: healer.z! }, 4);
        else {
          await sdk.spiritHealerActivate(healer.guid);
          say("spirit healer");
        }
      } else say("ghost with no corpse and no spirit healer in view");
      return report(false);
    }
    if (me !== undefined && dist(me, corpse) > 25) {
      await walk(corpse, 20);
      say("corpse run");
      return report(false);
    }
    const r = await sdk.reclaimCorpse(undefined, { timeout: Math.max(2_000, left() - 1_000) });
    say(`reclaim: ${r.status}`);
    return report(false);
  }

  // ------------------------------------------------------------ threat, health, bags
  const threat = attackers()[0];
  if (threat !== undefined) {
    await fight(threat);
    return report(false);
  }
  const pct = hpPct();
  if (pct !== undefined && (pct < 50 || (mem["resting"] === true && pct < 90))) {
    mem["resting"] = true;
    if (pct < 60 && (await heal())) return report(false);
    const woke = await sleep(Math.max(1_000, Math.min(20_000, left() - 1_000)));
    say(`resting at ${pct}% (${woke})`);
    return report(false);
  }
  mem["resting"] = false;
  const bag = state.bag();
  if ((bag.totalSlots > 0 && bag.freeSlots <= 1) || mem["bagsFull"] === true) {
    const me = here();
    const v = me === undefined ? undefined : [...route.vendors].sort((a, b) => dist(me, a.at) - dist(me, b.at))[0];
    if (v !== undefined && me !== undefined && dist(me, v.at) < 400) {
      if (await sellJunk(v.npc, v.at)) mem["bagsFull"] = false;
      return report(false);
    }
  }

  // ------------------------------------------------------------ the step
  const steps = route.steps;
  const step: GatedStep = steps[Math.min(args.cursor, steps.length - 1)]!;
  const stepKey = `${args.cursor}`;
  if (mem["stepKey"] !== stepKey) {
    mem["stepKey"] = stepKey;
    mem["stepStarted"] = Date.now();
    mem["patrol"] = 0;
    mem["moveFailures"] = 0;
  }
  const advance = async (why: string): Promise<TickReport> => {
    say(why);
    await writePad(name, args.cursor + 1);
    return report(true);
  };
  if (step.minLevel !== undefined && levelOf() < step.minLevel) return advance(`skip: below level ${step.minLevel}`);
  const spentMin = (Date.now() - Number(mem["stepStarted"] ?? Date.now())) / 60_000;
  if (step.kind !== "grind" && spentMin > (step.maxMinutes ?? 15)) return advance(`gave up after ${Math.round(spentMin)}m`);

  /** Reach an NPC by entry: walk toward where it stands until it is in view, then to it. */
  async function reach(npc: number, at: Point): Promise<UnitView | undefined> {
    const u = state.closest({ entry: npc, alive: true });
    if (u === undefined || u.x === undefined) {
      await walk(at, 6);
      if (Number(mem["moveFailures"] ?? 0) >= 4) say(`npc ${npc} not in view`);
      return undefined;
    }
    if ((u.distance ?? Infinity) <= 4.5) return u;
    try {
      const r = await sdk.moveTo(u, { timeout: Math.max(1_500, left() - 1_500) });
      if (!r.ok) say(`to npc ${npc}: ${r.status}`);
    } catch {
      return undefined;
    }
    const again = state.closest({ entry: npc, alive: true });
    return again !== undefined && (again.distance ?? Infinity) <= 5 ? again : undefined;
  }

  async function sellJunk(npc: number, at: Point): Promise<boolean> {
    const v = await reach(npc, at);
    if (v === undefined) return false;
    let sold = 0;
    for (const item of state.bag().items) {
      if (left() < 2_000) return false;
      if (item.quality !== 0) continue;
      const r = await sdk.sellItem(v, item.guid);
      if (r.ok) sold++;
    }
    say(`sold ${sold} junk`);
    return true;
  }

  if (step.kind === "visit") {
    const npc = await reach(step.npc, step.at);
    if (npc === undefined) {
      if (Number(mem["moveFailures"] ?? 0) >= 6) return advance(`npc ${step.npc} unreachable`);
      return report(false);
    }
    for (const q of step.turnIn ?? []) {
      if (left() < 3_000) return report(false);
      const e = state.quest(q);
      if (e === undefined) continue;
      if (!e.complete) {
        say(`${q} not complete`);
        continue;
      }
      let r = await sdk.turnInQuest(npc, q, undefined, { timeout: Math.min(10_000, left() - 1_000) });
      if (r.status === "choose_reward") {
        const choice = step.reward?.[q] ?? pickReward(r.choices);
        const chosen = r.choices.find((c) => c.index === choice);
        r = await sdk.turnInQuest(npc, q, choice, { timeout: Math.min(10_000, left() - 1_000) });
        if (r.ok && chosen !== undefined) await wear(chosen.itemId, chosen.item);
      }
      say(`turn in ${q}: ${r.status}`);
    }
    for (const q of step.accept ?? []) {
      if (left() < 3_000) return report(false);
      if (state.quest(q) !== undefined) continue;
      const r = await sdk.acceptQuestFrom(npc, q, { timeout: Math.min(10_000, left() - 1_000) });
      say(`accept ${q}: ${r.status}`);
    }
    return advance(`visited ${step.npc}`);
  }

  if (step.kind === "objectives") {
    const open = step.quests
      .map((q) => state.quest(q))
      .filter((e) => e !== undefined && !e.complete && e.objectives !== undefined);
    const waiting = step.quests.some((q) => {
      const e = state.quest(q);
      return e !== undefined && e.objectives === undefined;
    });
    if (open.length === 0 && !waiting) return advance(`objectives done: ${step.quests.join(",")}`);
    const kill = new Set<number>();
    const texts: string[] = [];
    for (const e of open) {
      for (const o of e!.objectives!) {
        if (o.done) continue;
        if (o.kind === "kill" && o.entry !== undefined) kill.add(o.entry);
        if (o.kind === "collect") {
          for (const d of step.drops ?? []) kill.add(d);
          if (o.text !== undefined) texts.push(o.text.toLowerCase());
        }
      }
    }
    // A world object whose name the open objective's own text carries.
    const node = texts.length === 0
      ? undefined
      : state
          .units({ type: "gameObject", maxDistance: 80 })
          .find((g) => g.name !== undefined && texts.some((t) => t.includes(g.name!.toLowerCase())));
    const prey = state
      .units({ entry: [...kill], type: "unit", alive: true, maxDistance: 70 })
      .find((u) => u.targetGuid === undefined || u.targetGuid === selfKey);
    const me = here()!;
    if (node !== undefined && (prey === undefined || dist(me, node) < dist(me, prey))) {
      if ((node.distance ?? Infinity) > 4) {
        await walk({ x: node.x!, y: node.y!, z: node.z! }, 3);
        return report(false);
      }
      const r = await sdk.lootCorpse(node.guid, { timeout: Math.min(8_000, Math.max(1_000, left() - 1_000)) });
      say(`gather: ${r.status}`);
      return report(false);
    }
    await hunt([...kill], step.areas, levelOf() + 3);
    return report(false);
  }

  if (step.kind === "train") {
    const npc = await reach(step.npc, step.at);
    if (npc === undefined) {
      if (Number(mem["moveFailures"] ?? 0) >= 6) return advance(`trainer ${step.npc} unreachable`);
      return report(false);
    }
    try {
      const list = await sdk.trainerList(npc, { timeout: Math.min(8_000, left() - 1_000) });
      for (const s of list.spells) {
        if (left() < 2_000) return report(false);
        if (!s.learnable || s.affordable === false) continue;
        const r = await sdk.buySpell(npc, s.spellId);
        say(`learn ${s.spellId}: ${r.status}`);
      }
    } catch (err) {
      say(`trainer: ${msg(err).slice(0, 80)}`);
    }
    return advance(`trained at ${step.npc}`);
  }

  if (step.kind === "vendor") {
    if (await sellJunk(step.npc, step.at)) return advance(`vendored at ${step.npc}`);
    if (Number(mem["moveFailures"] ?? 0) >= 6) return advance(`vendor ${step.npc} unreachable`);
    return report(false);
  }

  if (step.kind === "travel") {
    const i = Number(mem["patrol"] ?? 0);
    if (i >= step.via.length) return advance("arrived");
    if (await walk(step.via[i]!, 10)) mem["patrol"] = i + 1;
    else if (Number(mem["moveFailures"] ?? 0) >= 3) {
      say(`waypoint ${i} skipped`);
      mem["patrol"] = i + 1;
      mem["moveFailures"] = 0;
    }
    return report(false);
  }

  // grind: the last step, never done.
  await hunt(step.targets, step.areas, levelOf() + 2);
  return report(false);

  /**
   * A reward to take: an armor piece first (it fills or replaces a slot the
   * start gear leaves bare or white), then the one the vendor pays most for.
   */
  function pickReward(choices: readonly { index: number; item?: { class?: number | undefined; sellPrice?: number | undefined } | undefined }[]): number {
    let pick = choices[0]?.index ?? 0;
    let score = -1;
    for (const c of choices) {
      const s = (c.item?.class === 4 ? 1_000_000 : 0) + (c.item?.sellPrice ?? 0);
      if (s > score) {
        score = s;
        pick = c.index;
      }
    }
    return pick;
  }

  /** Put on a reward that is armor the character can wear now; the server's verdict is the answer. */
  async function wear(itemId: number, item: { class?: number | undefined; requiredLevel?: number | undefined } | undefined): Promise<void> {
    if (item?.class !== 4 || (item.requiredLevel ?? 0) > levelOf()) return;
    const carried = state.bag().items.find((i) => i.itemId === itemId);
    if (carried === undefined) return;
    try {
      const r = await sdk.equipItem(carried.bag, carried.slot);
      say(`equip ${itemId}: ${r.status}`);
    } catch (err) {
      say(`equip ${itemId}: ${msg(err).slice(0, 60)}`);
    }
  }
}
