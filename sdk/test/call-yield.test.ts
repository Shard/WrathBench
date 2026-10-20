/**
 * Every SDK call settles on a later turn of the event loop, the way a real
 * client's call always does: a refusal answered locally (dead, no such
 * target, a bad argument) or a wait the buffer already answers sent nothing
 * and did no I/O, and without the turn a loop over it only ever yields to
 * microtasks. That loop starves every timer and every IPC message in the
 * process — the sandbox's ping included, so the host kills the sandbox as
 * blocked. Seen in a party run (2026-10-20): a background
 * `for (;;) await sdk.killTarget(u.guid)` that spun once the character died.
 */
import { describe, expect, test } from "bun:test";

import { connect, type WrathClient } from "../src/client";
import { CREATURE_GUID, creatureCreate, creatureQuery, frames, loginSequence, selfCreate, selfHealth } from "./fixtures";
import { startStub, type StubServer } from "./server";

async function deadInWorld(): Promise<{ stub: StubServer; client: WrathClient }> {
  const stub = startStub({ onConnect: () => frames([...loginSequence, selfCreate, creatureCreate, creatureQuery, selfHealth(0, 20)]) });
  const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
  await client.createSession({ character: "Fenwick" });
  await client.events.waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT" && e.seq === 20, { timeout: 2000 });
  return { stub, client };
}

/**
 * Whether an immediate queued just before `call` has run by the time the
 * call settles, either way: the proof that the call crossed the event loop.
 */
async function crossesTheLoop(call: () => Promise<unknown>): Promise<boolean> {
  let ran = false;
  setImmediate(() => (ran = true));
  await call().catch(() => undefined);
  return ran;
}

describe("a call that sends nothing still crosses the event loop", () => {
  test("refusals answered locally, resolved or rejected, and a buffered wait", async () => {
    const { stub, client } = await deadInWorld();
    const sentBefore = stub.actions.length;
    const calls: Record<string, () => Promise<unknown>> = {
      "killTarget while dead": () => client.killTarget(CREATURE_GUID),
      "moveTo while dead": () => client.moveTo({ x: 1, y: 2, z: 3 }),
      "moveTo an unknown name": () => client.moveTo("Nobody By This Name"),
      "moveToAsync while dead (rejects)": () => client.moveToAsync({ x: 1, y: 2, z: 3 }),
      "killTarget on a bad guid (rejects)": () => client.killTarget("not a guid"),
      "events.waitFor answered from the buffer": () => client.events.waitFor((e) => e.opcode === "SMSG_UPDATE_OBJECT"),
      "events.waitForOpcode answered from the buffer": () => client.events.waitForOpcode("SMSG_UPDATE_OBJECT"),
    };
    const crossed: Record<string, boolean> = {};
    for (const [name, call] of Object.entries(calls)) crossed[name] = await crossesTheLoop(call);
    expect(crossed).toEqual(Object.fromEntries(Object.keys(calls).map((n) => [n, true])));
    // Every one of them was answered without a request.
    expect(stub.actions.slice(sentBefore).filter((a) => a.action !== "questgiver_status_query" && a.action !== "creature_query")).toEqual([]);
    client.close();
    await stub.stop();
  });

  test("a loop over a dead refusal lets a timer fire, and an own override deleted leaves the turn in place", async () => {
    const { stub, client } = await deadInWorld();
    // The run's shape: an own-property override, later deleted, falls back to the prototype.
    const own = client as unknown as Record<string, unknown>;
    own["killTarget"] = () => Promise.reject(new Error("overridden"));
    delete own["killTarget"];
    let fired = false;
    setTimeout(() => (fired = true), 5);
    // Bounded, so a regression fails here instead of freezing every test in the worker.
    let spins = 0;
    while (!fired && spins < 100_000) {
      const r = await client.killTarget(CREATURE_GUID);
      expect(r.status).toBe("dead");
      spins++;
    }
    expect(fired).toBe(true);
    client.close();
    await stub.stop();
  });

  test("a synchronous throw stays synchronous", async () => {
    const { stub, client } = await deadInWorld();
    expect(() => client.setTarget({} as never)).toThrow();
    client.close();
    await stub.stop();
  });
});
