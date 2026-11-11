/**
 * The module, as far as a fan-out run's seats need it
 * (wrath-mcp/module/PROTOCOL.md: `/lease`, `/session`, `/action`, `/events`),
 * keyed by token: a lease per token, one session per token, each token its
 * own stream. A session's first login sends the character's own create
 * block, so a seat has a state to read. Names are invented.
 */

import type { ServerWebSocket } from "bun";

/** The operator's port secret the stub accepts beside each lease's own. */
export const PORT_SECRET = "stub-port-secret-0123456789abcdef0123456789abcdef";

export interface Stub {
  url: string;
  sessions: Map<string, { account: string; character: string; guid: string }>;
  stop(): Promise<void>;
}

/** The module, as far as a seat needs it: a lease per token, one session per account, each token its own stream. */
export function startStub(): Stub {
  const sockets = new Map<string, Set<ServerWebSocket<{ token: string }>>>();
  const leases = new Map<string, { secret: string; account: string }>();
  const sessions = new Map<string, { account: string; character: string; guid: string }>();
  const guids = new Map<string, string>();
  const seqs = new Map<string, number>();
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const send = (token: string, opcode: string, data: unknown): void => {
    const seq = seqs.get(token) ?? 0;
    seqs.set(token, seq + 1);
    for (const ws of sockets.get(token) ?? []) ws.send(JSON.stringify({ seq, opcode, opcodeId: 0, ts: Date.now(), data }));
  };
  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (url.pathname === "/events") {
        const token = url.searchParams.get("token") ?? "";
        if (bearer !== PORT_SECRET && leases.get(token)?.secret !== bearer) return json({ ok: false, error: "unauthorized" }, 401);
        return srv.upgrade(req, { data: { token } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return json({ ok: true, module: "mod-wrathbench", protocol: 1, build: "stub" });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const token = String(body["token"] ?? "");
      if (bearer !== PORT_SECRET && leases.get(token)?.secret !== bearer) return json({ ok: false, error: "unauthorized" }, 401);
      if (url.pathname === "/lease" && req.method === "POST") {
        const secret = `${leases.size + 1}`.padStart(8, "0").padEnd(64, "e");
        leases.set(token, { secret, account: String(body["account"]) });
        return json({ ok: true, token, account: body["account"], secret, allowGm: false });
      }
      if (url.pathname === "/lease") return json({ ok: true, token, released: leases.delete(token) });
      if (url.pathname === "/session" && req.method === "POST") {
        const raw = String(body["character"] ?? "");
        const character = raw.slice(0, 1).toUpperCase() + raw.slice(1).toLowerCase();
        const account = leases.get(token)?.account ?? "RUNNER";
        if (!guids.has(character)) guids.set(character, String(301 + guids.size));
        const guid = guids.get(character)!;
        const fresh = sessions.get(token)?.character !== character;
        sessions.set(token, { account, character, guid });
        if (fresh) {
          setTimeout(() => {
            send(token, "SMSG_UPDATE_OBJECT", {
              blocks: 1,
              objects: [{ update: "create", guid, objectType: "player", self: true, moveFlags: 0, runSpeed: 7, pos: { x: -8900 + sessions.size, y: -120, z: 82, o: 1 }, fields: { entry: 0, health: 80, maxHealth: 100, level: 3, powerType: 0, power1: 40, maxPower1: 90, playerFlags: 0, unitFlags: 0, race: 1, class: 1 } }],
            });
          }, 5);
        }
        return json({ ok: true, account, character, guid, inWorld: true });
      }
      if (url.pathname === "/session") return sessions.delete(token) ? json({ ok: true }) : json({ ok: false, error: "no_session" }, 404);
      if (url.pathname === "/action") return json({ ok: true, action: body["action"] });
      return json({ ok: false, error: "not_found" }, 404);
    },
    websocket: {
      open(ws) {
        const set = sockets.get(ws.data.token) ?? new Set();
        sockets.set(ws.data.token, set);
        set.add(ws);
        const s = sessions.get(ws.data.token);
        if (s !== undefined) setTimeout(() => send(ws.data.token, "WB_SESSION_STATE", { character: s.character, guid: s.guid, inWorld: true, map: 0, x: -8900, y: -120, z: 82, o: 1, level: 3 }), 5);
      },
      message() {},
      close(ws) {
        sockets.get(ws.data.token)?.delete(ws);
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, sessions, stop: async () => void (await server.stop(true)) };
}
