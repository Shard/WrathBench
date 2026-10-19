/**
 * The SOAP client against a fake SOAP server (`Bun.serve`, in memory): the
 * request it sends (POST, Basic auth as STAGER, the `urn:AC` envelope with
 * the command escaped) and how it reads each answer ACSoap.cpp gives — a
 * result, 401, 403 for an account below SEC_ADMINISTRATOR, and a fault.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { SoapClient, SoapError, parseSoapResponse, soapEnvelope, soapFromEnv } from "./soap";

type Seen = { method: string; path: string; authorization: string | null; contentType: string | null; body: string };

const ok = (result: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:AC">` +
  `<SOAP-ENV:Body><ns1:executeCommandResponse><result>${result}</result></ns1:executeCommandResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const fault = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">` +
  `<SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>${text}</faultstring><detail>${text}</detail></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});

/** A fake SOAP console: records each request and answers with `reply`. */
function fake(reply: (seen: Seen) => { status: number; body: string }): { url: string; seen: Seen[] } {
  const seen: Seen[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const s: Seen = {
        method: req.method,
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      };
      seen.push(s);
      const r = reply(s);
      return new Response(r.body, { status: r.status, headers: { "content-type": "text/xml; charset=utf-8" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, seen };
}

describe("the request", () => {
  test("is a POST of the urn:AC executeCommand envelope, Basic-authenticated as STAGER with the password upper-cased", async () => {
    const f = fake(() => ({ status: 200, body: ok("") }));
    const soap = new SoapClient({ url: f.url, password: "s3cret-pw" });
    expect(await soap.execute(".server info")).toBe("");
    expect(f.seen).toHaveLength(1);
    const s = f.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.path).toBe("/");
    expect(s.contentType).toContain("text/xml");
    expect(s.authorization).toBe(`Basic ${Buffer.from("STAGER:S3CRET-PW").toString("base64")}`);
    expect(s.body).toContain('xmlns:ns1="urn:AC"');
    expect(s.body).toContain("<ns1:executeCommand><command>.server info</command></ns1:executeCommand>");
    expect(s.body).toContain('<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"');
  });

  test("escapes the command, so nothing in it can close the element", () => {
    const body = soapEnvelope(`.say <b>&"'</command><x>`);
    expect(body).toContain("<command>.say &lt;b&gt;&amp;&quot;&apos;&lt;/command&gt;&lt;x&gt;</command>");
    expect(body.match(/<\/command>/g)).toHaveLength(1);
  });

  test(".additem names the character, the entry and the count; refuses anything that is not a name or a positive id", async () => {
    const f = fake(() => ({ status: 200, body: ok("") }));
    const soap = new SoapClient({ url: f.url, password: "pw" });
    await soap.addItem("Tankpartyb", 6721, 1);
    await soap.addItem("Huntpartyf", 2519, 1000);
    expect(f.seen.map((s) => /<command>(.*)<\/command>/.exec(s.body)![1])).toEqual([".additem Tankpartyb 6721 1", ".additem Huntpartyf 2519 1000"]);
    await expect(soap.addItem("Tank partyb", 1)).rejects.toThrow(/not a character name/);
    await expect(soap.addItem("Tank;.server shutdown", 1)).rejects.toThrow(/not a character name/);
    await expect(soap.addItem("Tankpartyb", 0)).rejects.toThrow(/refusing \.additem/);
    await expect(soap.addItem("Tankpartyb", 6721, -1)).rejects.toThrow(/refusing \.additem/);
    expect(f.seen).toHaveLength(2);
  });

  test("never holds the password where it would print", () => {
    const soap = new SoapClient({ url: "http://127.0.0.1:1/", password: "hunter2pw" });
    expect(JSON.stringify(soap)).not.toMatch(/hunter2|HUNTER2/i);
    expect(Bun.inspect(soap)).not.toMatch(/HUNTER2/i);
    expect(Bun.inspect(soap)).not.toContain(Buffer.from("STAGER:HUNTER2PW").toString("base64"));
    expect(Object.keys(soap)).toEqual(["url", "account"]);
  });
});

describe("the answers", () => {
  test("200 with a result is the command's output, unescaped", async () => {
    const f = fake(() => ({ status: 200, body: ok("Uptime: 3 minutes &amp; 2 seconds") }));
    expect(await new SoapClient({ url: f.url, password: "pw" }).execute(".server info")).toBe("Uptime: 3 minutes & 2 seconds");
  });

  test("403 is a typed refusal: the account is below SEC_ADMINISTRATOR, and SOAP runs nothing for it", async () => {
    const f = fake(() => ({ status: 403, body: "" }));
    const soap = new SoapClient({ url: f.url, password: "pw" });
    const err = await soap.check().catch((e) => e);
    expect(err).toBeInstanceOf(SoapError);
    expect((err as SoapError).refusal.kind).toBe("not_admin");
    expect((err as SoapError).refusal.status).toBe(403);
    expect((err as SoapError).message).toMatch(/below SEC_ADMINISTRATOR/);
  });

  test("401 is a refused credential", async () => {
    const f = fake((s) => (s.authorization === `Basic ${Buffer.from("STAGER:RIGHT").toString("base64")}` ? { status: 200, body: ok("") } : { status: 401, body: "" }));
    const wrong = await new SoapClient({ url: f.url, password: "wrong" }).execute(".server info").catch((e) => e);
    expect((wrong as SoapError).refusal.kind).toBe("unauthorized");
    expect(await new SoapClient({ url: f.url, password: "right" }).execute(".server info")).toBe("");
  });

  test("a fault is the command failing, with the command's own text", async () => {
    const f = fake(() => ({ status: 500, body: fault("Player not found!") }));
    const err = await new SoapClient({ url: f.url, password: "pw" }).addItem("Nobodyhere", 6721).catch((e) => e);
    expect((err as SoapError).refusal).toEqual({ kind: "fault", status: 500, message: "Player not found!" });
    expect((err as SoapError).command).toBe(".additem Nobodyhere 6721 1");
  });

  test("a partial store answers success with 'Cannot create item', which addItem reads as a failure", async () => {
    const f = fake(() => ({ status: 200, body: ok("Cannot create item '3770' (amount: 15)") }));
    const soap = new SoapClient({ url: f.url, password: "pw" });
    const err = await soap.addItem("Tankpartyb", 3770, 20).catch((e) => e);
    expect(err).toBeInstanceOf(SoapError);
    expect((err as SoapError).message).toContain("Cannot create item");
    // execute itself does not judge the text.
    expect(await soap.execute(".additem Tankpartyb 3770 20")).toContain("Cannot create item");
  });

  test("no server is a transport refusal, not a hang", async () => {
    const err = await new SoapClient({ url: "http://127.0.0.1:1/", password: "pw", timeoutMs: 2000 }).execute(".server info").catch((e) => e);
    expect((err as SoapError).refusal.kind).toBe("transport");
  });

  test("parseSoapResponse reads a 200 that is not an executeCommandResponse as an error", () => {
    expect(parseSoapResponse(200, "<html>proxy</html>")).toMatchObject({ ok: false, refusal: { kind: "http" } });
    expect(parseSoapResponse(502, "bad gateway")).toMatchObject({ ok: false, refusal: { kind: "http", status: 502 } });
    expect(parseSoapResponse(200, ok("<x>"))).toMatchObject({ ok: true });
  });
});

describe("soapFromEnv", () => {
  test("takes the URL and password from the environment and names the key when it is missing", () => {
    expect(() => soapFromEnv({})).toThrow(/WRATHBENCH_STAGER_PASSWORD is not set/);
    expect(soapFromEnv({ WRATHBENCH_STAGER_PASSWORD: "pw" }).url).toBe("http://worldserver:7878/");
    expect(soapFromEnv({ WRATHBENCH_STAGER_PASSWORD: "pw", WRATHBENCH_SOAP_URL: "http://127.0.0.1:7878/" }).url).toBe("http://127.0.0.1:7878/");
  });
});
