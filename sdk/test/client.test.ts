import { describe, expect, test } from "bun:test";

import { connect, WrathRequestError, WrathTransportError } from "../src/client";
import { EventTimeoutError } from "../src/events";
import { chatEcho, frames, loginSequence } from "./fixtures";
import { startStub } from "./server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("client: the happy path through the slice", () => {
  test("connect -> createSession -> say -> chat -> logout, with the cache following along", async () => {
    const stub = startStub({ onConnect: () => frames(loginSequence) });
    const client = await connect({ baseUrl: stub.baseUrl, token: "run-test", events: { reconnect: false } });

    const health = await client.health();
    expect(health.module).toBe("mod-wrathbench");

    const session = await client.createSession({ character: "Fenwick", race: 1, class: 1, gender: 0 });
    expect(session.inWorld).toBe(true);
    expect(session.guid).toBe(7n);

    // The login events arrived while the POST was in flight; the cache has them.
    await client.events.waitForOpcode("SMSG_LOGIN_VERIFY_WORLD", { timeout: 2000 });
    expect(client.state.self.guid).toBe(7n);
    expect(client.state.self.name).toBe("Fenwick");
    expect(client.state.self.level?.value).toBe(3);
    expect(client.state.self.position?.value.map).toBe(0);
    expect(client.state.characters?.value).toHaveLength(2);

    const ack = await client.say("ping from the fixture");
    expect(ack.action).toBe("say");
    stub.push(JSON.stringify(chatEcho));

    const entry = await client.waitForChat("ping from the fixture", { timeout: 2000 });
    expect(entry.senderGuid).toBe(7n);
    expect(entry.seq).toBe(4);
    expect(client.state.chat.at(-1)?.message).toBe("ping from the fixture");

    const bye = await client.logout();
    expect(bye.ok).toBe(true);

    client.close();
    await stub.stop();
  });

  test("waitForChat accepts a predicate and can time out", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", events: { reconnect: false } });
    const pending = client.waitForChat((e) => e.message.startsWith("ping"), { timeout: 1000 });
    stub.push(JSON.stringify(chatEcho));
    expect((await pending).message).toBe("ping from the fixture");

    await expect(client.waitForChat("never said", { timeout: 20 })).rejects.toBeInstanceOf(
      EventTimeoutError,
    );
    client.close();
    await stub.stop();
  });

  test("connect can skip the subscription for a health-only client", async () => {
    const stub = startStub();
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    expect((await client.health()).ok).toBe(true);
    expect(client.events.connected).toBe(false);
    client.close();
    await stub.stop();
  });
});

describe("client: the two error channels", () => {
  test("a request error is a WrathRequestError of kind request", async () => {
    const stub = startStub({
      routes: { session: () => json({ ok: false, error: "token_in_use" }, 409) },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.createSession({ character: "Fenwick" }).catch((e) => e)) as WrathRequestError;
    expect(err).toBeInstanceOf(WrathRequestError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("token_in_use");
    expect(err.kind).toBe("request");
    await stub.stop();
  });

  test("a synchronous game rejection is kind game, with the result code parsed out", async () => {
    const stub = startStub({
      routes: {
        session: () => json({ ok: false, error: "char_create_failed_code_47", token: "t" }, 502),
      },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.createSession({ character: "Fenwick" }).catch((e) => e)) as WrathRequestError;
    expect(err.kind).toBe("game");
    expect(err.charCreateResultCode).toBe(47);
    expect(err.status).toBe(502);
    await stub.stop();
  });

  test("login_failed and timeout are game-level too", async () => {
    for (const [code, status] of [
      ["login_failed", 502],
      ["timeout", 504],
    ] as const) {
      const stub = startStub({ routes: { session: () => json({ ok: false, error: code }, status) } });
      const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
      const err = (await client.createSession({ character: "F" }).catch((e) => e)) as WrathRequestError;
      expect(err.kind).toBe("game");
      expect(err.code).toBe(code);
      await stub.stop();
    }
  });

  test("an error code this SDK revision does not know still parses", async () => {
    const stub = startStub({
      routes: { action: () => json({ ok: false, error: "some_future_code" }, 400) },
    });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    const err = (await client.say("hi").catch((e) => e)) as WrathRequestError;
    expect(err.code).toBe("some_future_code");
    expect(err.kind).toBe("request");
    await stub.stop();
  });

  test("an unreachable module is a transport error", async () => {
    const stub = startStub();
    const port = new URL(stub.baseUrl).port;
    await stub.stop();
    const client = await connect({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "t",
      subscribeEvents: false,
      requestTimeoutMs: 500,
    });
    await expect(client.health()).rejects.toBeInstanceOf(WrathTransportError);
  });

  test("a response that does not match the protocol is a transport error", async () => {
    const stub = startStub({ routes: { health: () => json({ ok: true, module: 42 }, 200) } });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await expect(client.health()).rejects.toBeInstanceOf(WrathTransportError);
    await stub.stop();
  });

  test("a non-JSON body is a transport error", async () => {
    const stub = startStub({ routes: { health: () => new Response("<html>", { status: 200 }) } });
    const client = await connect({ baseUrl: stub.baseUrl, token: "t", subscribeEvents: false });
    await expect(client.health()).rejects.toBeInstanceOf(WrathTransportError);
    await stub.stop();
  });
});
