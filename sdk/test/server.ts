/**
 * A stand-in for the module: `Bun.serve` speaking the same HTTP + WebSocket
 * shapes as module/PROTOCOL.md, replaying fixture frames. Lets the whole SDK be
 * exercised — including reconnects and error bodies — with no game stack.
 */

import type { ServerWebSocket } from "bun";

export interface StubOptions {
  /** Frames pushed to every subscriber as soon as it connects. */
  onConnect?: (index: number) => readonly string[];
  /** Close the socket after pushing, so the SDK has to reconnect. */
  closeAfterPush?: boolean;
  /** Override handlers per route; return undefined to fall through to defaults. */
  routes?: Partial<Record<"health" | "session" | "action" | "deleteSession", () => Response>>;
}

export interface StubServer {
  baseUrl: string;
  wsUrl: string;
  /** Push a frame to every open subscriber. */
  push(frame: string): void;
  /** Close every open subscriber socket without stopping the server. */
  dropSockets(): void;
  connections: number;
  sockets: ServerWebSocket<{ token: string }>[];
  stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function startStub(options: StubOptions = {}): StubServer {
  const sockets = new Set<ServerWebSocket<{ token: string }>>();
  let connections = 0;

  const server = Bun.serve<{ token: string }, never>({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const token = url.searchParams.get("token") ?? "";
        if (srv.upgrade(req, { data: { token } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") {
        return (
          options.routes?.health?.() ??
          json({
            ok: true,
            module: "mod-wrathbench",
            worldStopped: false,
            sessions: sockets.size,
            droppedPackets: 0,
            droppedPacketsLive: 0,
          })
        );
      }
      if (url.pathname === "/session" && req.method === "POST") {
        return (
          options.routes?.session?.() ??
          json({
            ok: true,
            token: "stub",
            account: "RUNNER",
            character: "Fenwick",
            guid: 7,
            inWorld: true,
          })
        );
      }
      if (url.pathname === "/session" && req.method === "DELETE") {
        return options.routes?.deleteSession?.() ?? json({ ok: true, token: "stub" });
      }
      if (url.pathname === "/action" && req.method === "POST") {
        return options.routes?.action?.() ?? json({ ok: true, action: "say", token: "stub" });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const frames = options.onConnect?.(connections) ?? [];
        connections++;
        for (const f of frames) ws.send(f);
        if (options.closeAfterPush) {
          // Give the frames a tick to land before tearing the socket down.
          setTimeout(() => ws.close(), 10);
        }
      },
      message() {
        /* the channel is send-only */
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl: base,
    wsUrl: `ws://127.0.0.1:${server.port}`,
    push(frame) {
      for (const ws of sockets) ws.send(frame);
    },
    dropSockets() {
      for (const ws of sockets) ws.close();
    },
    get connections() {
      return connections;
    },
    get sockets() {
      return [...sockets];
    },
    async stop() {
      await server.stop(true);
    },
  };
}
