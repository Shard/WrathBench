/**
 * The camera pod's loopback forwarder (infra/camera-pods.ts): every realm row
 * advertises 127.0.0.1:8085 (infra/world.ts `putRealm`), so a client in a pod
 * of its own is handed its own loopback. The director listens there and pipes
 * each connection to the world's real address (`<id>.worlds:8085`, or the
 * `worldserver` Service for the shared world).
 */

import type { Socket } from "bun";

/** One direction's writer: what a short write leaves is kept and sent on drain, in order. */
class Pipe {
  private pending: Uint8Array[] = [];
  constructor(private sock: Socket<unknown> | null = null) {}
  attach(sock: Socket<unknown>): void {
    this.sock = sock;
    this.drain();
  }
  write(chunk: Uint8Array): void {
    this.pending.push(new Uint8Array(chunk));
    this.drain();
  }
  drain(): void {
    if (this.sock === null) return;
    while (this.pending.length > 0) {
      const head = this.pending[0]!;
      const n = this.sock.write(head);
      if (n >= head.length) this.pending.shift();
      else {
        if (n > 0) this.pending[0] = head.subarray(n);
        return;
      }
    }
  }
  end(): void {
    this.sock?.end();
  }
}

type Side = { toPeer: Pipe; toSelf: Pipe };

export function forwardLoopback(listenPort: number, target: { host: string; port: number }, log: (line: string) => void = () => {}): { stop(): void } {
  const server = Bun.listen<Side>({
    hostname: "127.0.0.1",
    port: listenPort,
    socket: {
      async open(client) {
        const toUpstream = new Pipe();
        const toClient = new Pipe(client as Socket<unknown>);
        client.data = { toPeer: toUpstream, toSelf: toClient };
        try {
          const upstream = await Bun.connect<Side>({
            hostname: target.host,
            port: target.port,
            socket: {
              open(s) {
                s.data = { toPeer: toClient, toSelf: toUpstream };
              },
              data(s, chunk) {
                s.data.toPeer.write(chunk);
              },
              drain(s) {
                s.data.toSelf.drain();
              },
              close(s) {
                s.data.toPeer.end();
              },
              error(s) {
                s.data.toPeer.end();
              },
            },
          });
          toUpstream.attach(upstream as Socket<unknown>);
        } catch (e) {
          log(`forward: ${target.host}:${target.port} refused: ${e instanceof Error ? e.message : String(e)}`);
          client.end();
        }
      },
      data(client, chunk) {
        client.data.toPeer.write(chunk);
      },
      drain(client) {
        client.data.toSelf.drain();
      },
      close(client) {
        client.data.toPeer.end();
      },
      error(client) {
        client.data.toPeer.end();
      },
    },
  });
  log(`forward: 127.0.0.1:${listenPort} -> ${target.host}:${target.port}`);
  return { stop: () => server.stop(true) };
}
