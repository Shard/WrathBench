/**
 * A tiny fake world for the scripted reference program: just enough of the
 * SDK client and the state cache for `referenceTick` to play a few route
 * steps against, and a fake sandbox that evaluates the adapter's snippets the
 * way the real child does — through `compileSnippet`, as an `AsyncFunction`,
 * with the ambient surface on the global and the console captured.
 *
 * Deliberately dumb: moves arrive at once, fights are won, loot drops, sleep
 * resolves now. What it pins is the program's decisions and the adapter's
 * bookkeeping, not combat.
 */

import type { SandboxHost, SnippetResult } from "../../src/sandbox/host";
import { compileSnippet } from "../../src/sandbox/rewrite";

export interface FakeQuestDef {
  id: number;
  /** Entries of the NPCs that offer it. */
  from: number[];
  /** The NPC that ends it. */
  to: number;
  /** Quest ids that must be turned in first. */
  after?: number[];
  objectives: { kind: "kill" | "collect"; entry: number; required: number; text?: string; dropFrom?: number[] }[];
  xp: number;
}

export interface FakeUnitDef {
  entry: number;
  x: number;
  y: number;
  z: number;
  name?: string;
  type?: "unit" | "gameObject";
  level?: number;
  roles?: string[];
}

interface Unit extends FakeUnitDef {
  guid: string;
  dead: boolean;
}

interface LogEntryState {
  questId: number;
  objectives: { kind: "kill" | "collect"; entry: number; text: string | undefined; required: number; have: number; done: boolean }[];
}

export class FakeWorld {
  units: Unit[] = [];
  log = new Map<number, LogEntryState>();
  done = new Set<number>();
  self = { x: -8949, y: -132, z: 83.5, level: 1, hp: 100, maxHp: 100, ghost: false, xp: 0 };
  selfKey: string | undefined;
  pad = "";
  calls: string[] = [];
  private next = 1000;

  constructor(
    readonly quests: FakeQuestDef[],
    units: FakeUnitDef[],
  ) {
    for (const u of units) this.spawn(u);
  }

  spawn(u: FakeUnitDef): Unit {
    const unit = { ...u, guid: String(this.next++), dead: false };
    this.units.push(unit);
    return unit;
  }

  private view(u: Unit) {
    const distance = Math.hypot(u.x - this.self.x, u.y - this.self.y);
    return {
      guid: u.guid,
      entry: u.entry,
      name: u.name,
      type: u.type ?? "unit",
      level: u.level ?? 1,
      health: u.dead ? 0 : 50,
      maxHealth: 50,
      dead: u.dead,
      distance,
      x: u.x,
      y: u.y,
      z: u.z,
      targetGuid: undefined,
      ownerGuid: undefined,
      questGiver: undefined,
      questGiverStatus: undefined,
      roles: u.roles ?? [],
      goType: u.type === "gameObject" ? "chest" : undefined,
      docked: undefined,
    };
  }

  private complete(e: LogEntryState): boolean {
    return e.objectives.every((o) => o.done);
  }

  private questEntry(e: LogEntryState) {
    return {
      slot: 0,
      questId: e.questId,
      title: undefined,
      objectives: e.objectives.map((o) => ({ ...o })),
      state: this.complete(e) ? 1 : 0,
      complete: this.complete(e),
      counts: [0, 0, 0, 0] as const,
      timer: undefined,
      seq: 0,
      ts: 0,
    };
  }

  private credit(kind: "kill" | "collect", entry: number, source: number): void {
    for (const e of this.log.values()) {
      const def = this.quests.find((q) => q.id === e.questId)!;
      for (const [i, o] of e.objectives.entries()) {
        if (o.done || o.kind !== kind) continue;
        const d = def.objectives[i]!;
        const hit = kind === "kill" ? o.entry === entry : (d.dropFrom ?? []).includes(source);
        if (!hit) continue;
        o.have++;
        o.done = o.have >= o.required;
      }
    }
  }

  private byGuid(t: unknown): Unit | undefined {
    const g = typeof t === "string" ? t : (t as { guid?: string }).guid;
    return this.units.find((u) => u.guid === g);
  }

  /** The ambient snippet surface over this world. */
  ambient() {
    const w = this;
    const units = (f: { entry?: number | number[]; type?: string; alive?: boolean; maxDistance?: number; role?: string } = {}) => {
      const entries = f.entry === undefined ? undefined : Array.isArray(f.entry) ? f.entry : [f.entry];
      return w.units
        .filter((u) => entries === undefined || entries.includes(u.entry))
        .filter((u) => f.type === undefined || (u.type ?? "unit") === f.type)
        .filter((u) => f.alive !== true || !u.dead)
        .filter((u) => f.role === undefined || (u.roles ?? []).includes(f.role))
        .map((u) => w.view(u))
        .filter((u) => f.maxDistance === undefined || u.distance <= f.maxDistance)
        .filter((u) => u.distance <= 150)
        .sort((a, b) => a.distance - b.distance);
    };
    const observed = <T>(value: T) => ({ value, seq: 0, ts: 0 });
    const state = {
      get self() {
        return {
          name: w.selfKey === undefined ? undefined : "Fake",
          level: observed(w.self.level),
          health: observed({ current: w.self.ghost ? 1 : w.self.hp, max: w.self.maxHp }),
          power: observed({ current: 100, max: 100 }),
          position: w.selfKey === undefined ? undefined : observed({ map: 0, x: w.self.x, y: w.self.y, z: w.self.z }),
          ghost: observed(w.self.ghost),
          corpse: undefined,
        };
      },
      get xp() {
        return observed(w.self.xp);
      },
      units,
      closest: (f: Parameters<typeof units>[0]) => units(f)[0],
      quest: (id: number) => {
        const e = w.log.get(id);
        return e === undefined ? undefined : w.questEntry(e);
      },
      bag: () => ({ items: [], freeSlots: 16, totalSlots: 16, bags: [] }),
      spell: () => undefined,
      aurasOf: () => [],
    };
    const sdk = {
      get selfKey() {
        return w.selfKey;
      },
      createSession: async (r: { character: string; race?: number; class?: number }) => {
        w.calls.push(`createSession ${r.character} ${r.race}/${r.class}`);
        w.selfKey = "1";
        return { ok: true, inWorld: true };
      },
      moveTo: async (t: { x?: number; y?: number; z?: number; guid?: string }) => {
        const u = w.byGuid(t);
        const p = u ?? t;
        w.self.x = p.x!;
        w.self.y = p.y!;
        w.self.z = p.z!;
        w.calls.push(`moveTo ${Math.round(p.x!)},${Math.round(p.y!)}`);
        return { ok: true, status: "arrived", position: { ...w.self } };
      },
      killTarget: async (t: unknown) => {
        const u = w.byGuid(t)!;
        u.dead = true;
        w.credit("kill", u.entry, u.entry);
        w.calls.push(`kill ${u.entry}`);
        w.self.xp += 10;
        return { ok: true, status: "killed" };
      },
      lootCorpse: async (g: string) => {
        const u = w.byGuid(g)!;
        w.credit("collect", u.entry, u.entry);
        if (u.type === "gameObject") u.dead = true;
        // Respawn, so a hunt always has prey.
        w.spawn({ entry: u.entry, x: u.x + 3, y: u.y, z: u.z, ...(u.name !== undefined ? { name: u.name } : {}), ...(u.type !== undefined ? { type: u.type } : {}) });
        return { ok: true, status: "looted", gold: 0, items: [{ itemId: 1, count: 1 }], window: [] };
      },
      acceptQuestFrom: async (npc: unknown, q: number) => {
        const u = w.byGuid(npc)!;
        const def = w.quests.find((d) => d.id === q);
        const offered = def !== undefined && def.from.includes(u.entry) && (def.after ?? []).every((a) => w.done.has(a)) && !w.done.has(q);
        w.calls.push(`accept ${q} ${offered ? "ok" : "no"}`);
        if (!offered) return { ok: false, status: "not_offered", questId: q, offered: [] };
        w.log.set(q, {
          questId: q,
          objectives: def.objectives.map((o) => ({ kind: o.kind, entry: o.entry, text: o.text, required: o.required, have: 0, done: o.required === 0 })),
        });
        return { ok: true, status: "accepted", questId: q };
      },
      turnInQuest: async (npc: unknown, q: number) => {
        const u = w.byGuid(npc)!;
        const e = w.log.get(q);
        const def = w.quests.find((d) => d.id === q)!;
        if (e === undefined || !w.complete(e)) return { ok: false, status: "not_complete", questId: q, hint: "" };
        if (def.to !== u.entry) return { ok: false, status: "wrong_questgiver", questId: q, hint: "" };
        w.log.delete(q);
        w.done.add(q);
        w.self.xp += def.xp;
        while (w.self.xp >= w.self.level * 400) w.self.level++;
        w.calls.push(`turnIn ${q}`);
        return { ok: true, status: "complete", questId: q, xp: def.xp, money: 0 };
      },
      trainerList: async () => ({ ok: true, trainerType: 0, spells: [] }),
      buySpell: async () => ({ ok: true, status: "learned" }),
      sellItem: async () => ({ ok: true, status: "sold" }),
      equipItem: async () => ({ ok: true, status: "equipped" }),
      castSpell: async () => ({ ok: true }),
      repop: async () => ({ ok: true }),
      reclaimCorpse: async () => ({ ok: true, status: "reclaimed" }),
      spiritHealerActivate: async () => ({ ok: true }),
    };
    return {
      sdk,
      state,
      connect: async () => undefined,
      sleep: async () => "elapsed",
      scratchpad: {
        read: async () => w.pad,
        write: async (c: string) => {
          w.pad = c;
          return { ok: true };
        },
      },
    };
  }
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => () => Promise<unknown>;

/**
 * A sandbox that evaluates each snippet as the child does: compiled by the
 * real `compileSnippet`, run as an `AsyncFunction` over the global, with the
 * ambient names bound there and `console` captured into the result's logs.
 * `dropBindings()` drops the global bindings the way a respawned child has none.
 */
export function referenceSandbox(world: FakeWorld): SandboxHost & { snippets: string[]; dropBindings(): void } {
  const snippets: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const fake = {
    snippets,
    dropBindings: () => {
      delete g["__wbReference"];
      delete g["__wbRef"];
      world.selfKey = undefined;
    },
    evalSnippet: async (code: string): Promise<SnippetResult> => {
      snippets.push(code);
      const amb = world.ambient();
      const saved = { console: g["console"], sdk: g["sdk"], state: g["state"], connect: g["connect"], sleep: g["sleep"], scratchpad: g["scratchpad"] };
      const logs: SnippetResult["logs"] = [];
      const cap = { ...console, log: (...a: unknown[]) => logs.push({ level: "log", ts: Date.now(), text: a.map(String).join(" ") }) };
      Object.assign(g, { console: cap, ...amb });
      const t0 = Date.now();
      try {
        const compiled = compileSnippet(code);
        await new AsyncFunction(compiled.statementsBody).call(globalThis);
        return { ok: true, logs, durationMs: Date.now() - t0 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), logs, durationMs: Date.now() - t0 };
      } finally {
        Object.assign(g, saved);
      }
    },
    recentEvents: () => Promise.resolve([]),
    stateSnapshot: () => Promise.resolve({ self: {}, lastSeq: -1, eventCount: 0 }),
    totalRestarts: 0,
    consecutiveRestarts: 0,
    drainNotices: () => [],
    stop: () => Promise.resolve(),
  };
  return fake as unknown as SandboxHost & { snippets: string[]; dropBindings(): void };
}

/** Northshire's opening as the fake world plays it: 783, then 7's vermin. */
export function northshireOpening(): FakeWorld {
  return new FakeWorld(
    [
      { id: 783, from: [823], to: 197, objectives: [], xp: 80 },
      { id: 7, from: [197], to: 197, after: [783], objectives: [{ kind: "kill", entry: 6, required: 3 }], xp: 170 },
      { id: 5261, from: [823], to: 196, objectives: [], xp: 40 },
      { id: 33, from: [196], to: 196, after: [5261], objectives: [{ kind: "collect", entry: 750, required: 2, dropFrom: [299] }], xp: 200 },
    ],
    [
      { entry: 823, x: -8948, y: -132, z: 84, roles: ["questGiver"] },
      { entry: 197, x: -8903, y: -163, z: 82, roles: ["questGiver"] },
      { entry: 925, x: -8915, y: -215, z: 82, roles: ["trainer"] },
      { entry: 196, x: -8869, y: -163, z: 81, roles: ["questGiver"] },
      { entry: 6, x: -8790, y: -165, z: 83 },
      { entry: 6, x: -8780, y: -175, z: 83 },
      { entry: 299, x: -8830, y: -110, z: 83 },
    ],
  );
}
