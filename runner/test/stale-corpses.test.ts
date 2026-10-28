/**
 * The HUD's nearby line over stale corpses (Deadmines attempt a8): bones —
 * a corpse whose owner is alive again — are not named "<name>'s corpse", and
 * an owner's older corpse gives way to the newer. Fixture-based: a stand-in
 * module answers the real sandbox child, with invented names and guids.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatStateSummary } from "../src/context";
import { SandboxHost } from "../src/sandbox/host";
import { Scratchpad } from "@wrathbench/mcp";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();
const TOKEN = "stale-corpses-token-0123456789";

const hosts: SandboxHost[] = [];
const stubs: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0, hosts.length).map((h) => h.stop()));
  await Promise.all(stubs.splice(0, stubs.length).map((s) => s.stop()));
});

/** Acks every action. */
function startModuleStub(): string {
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        return srv.upgrade(req, { data: { token: "" } }) ? undefined : new Response("no", { status: 400 });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return Response.json({ ok: true, account: "RUNNER", character: "Fenwick", guid: 7, inWorld: true });
      }
      if (url.pathname === "/action") {
        return req.json().then((raw) => Response.json({ ok: true, action: String((raw as Record<string, unknown>)["action"]) }));
      }
      return new Response("not found", { status: 404 });
    },
    websocket: { message() {} },
  });
  stubs.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

function makeHost(moduleUrl: string): SandboxHost {
  const dir = tempDir("wrathbench-stale-corpses-sbx-");
  const host = new SandboxHost({
    moduleUrl,
    token: TOKEN,
    scratchpad: new Scratchpad(join(dir, "scratchpad.md")),
    snippetTimeoutMs: 6_000,
    pingGraceMs: 1_000,
  });
  hosts.push(host);
  return host;
}

const corpseCreate = (guid: string, y: number, fields: string) =>
  `{ update: "create", guid: "${guid}", objectType: "corpse", pos: { x: 1, y: ${y}, z: 3, o: 0 }, fields: ${fields} }`;
const updateObject = (seq: number, blocks: string[]) =>
  `events.ingest(JSON.stringify({ seq: ${seq}, opcode: "SMSG_UPDATE_OBJECT", opcodeId: 0x0a9, ts: ${1000 + seq}, ` +
  `data: { blocks: ${blocks.length}, objects: [${blocks.join(",")}] } }));`;
const nameAnswer = (seq: number, guid: string, name: string) =>
  `events.ingest(JSON.stringify({ seq: ${seq}, opcode: "SMSG_NAME_QUERY_RESPONSE", opcodeId: 0x051, ts: ${1000 + seq}, ` +
  `data: { guid: "${guid}", found: true, name: "${name}" } }));`;

describe("the HUD's nearby line: bones and an owner's older corpse", () => {
  test("bones are not named as a corpse; of one owner's two corpses only the newer is", async () => {
    const host = makeHost(startModuleStub());
    await host.evalSnippet("await connect(); await sdk.createSession({ character: 'Fenwick' });");
    await host.evalSnippet(
      updateObject(1, [
        // Palafriend came back to life: the corpse is bones now.
        corpseCreate("17366161638117343239", 2, `{ scale: 1, corpseOwnerGuid: "965", corpseFlags: 5 }`),
        // Brannick died twice and the cache kept both corpses.
        corpseCreate("17366161638117343240", 3, `{ scale: 1, corpseOwnerGuid: "966", corpseFlags: 4 }`),
      ]) +
        updateObject(2, [corpseCreate("17366161638117343241", 4, `{ scale: 1, corpseOwnerGuid: "966", corpseFlags: 4 }`)]) +
        nameAnswer(3, "965", "Palafriend") +
        nameAnswer(4, "966", "Brannick"),
    );
    const snap = (await host.stateSnapshot()) as { units: { guid: string }[] };
    expect(snap.units.map((u) => u.guid)).toEqual(["17366161638117343241"]);
    const text = formatStateSummary(snap, { sessionLive: true });
    expect(text).toMatch(/nearby: Brannick's corpse \(\?y\)/);
    expect(text).not.toContain("Palafriend");
  });
});
