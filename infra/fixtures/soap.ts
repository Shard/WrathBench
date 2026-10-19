/**
 * A small client for AzerothCore's SOAP console (`ACSoap.cpp` at the pinned
 * core): one operation, `ns1:executeCommand(command) -> result`, over HTTP
 * POST with Basic authentication, the command queued onto the world thread's
 * CLI queue exactly as a console line would be.
 *
 * Operator tooling for the party stager only (docs/proposals/GROUP-PLAY.md
 * §3, route (c)). Nothing in `runner/` or `sdk/` imports this, the account it
 * authenticates as (`STAGER`) is not on the module's allowlist, and SOAP is
 * kept out of the agent's reach by the sandbox's single-port rule, the run
 * pods' egress policy, the worldserver's ingress rule and a credential no run
 * pod carries. The client never logs the password and never puts it on argv.
 *
 * How the server answers, read off `ns1__executeCommand`:
 *   - no credentials, an unknown account or a wrong password: HTTP 401;
 *   - an account below SEC_ADMINISTRATOR: HTTP 403;
 *   - a command that ran: 200 and `<result>` (often empty — `.additem` from the
 *     console prints nothing on success);
 *   - a command that failed: a SOAP fault, HTTP 500, whose `<faultstring>` is
 *     the command's own output ("Player not found!", "Cannot create item…").
 */

export const SOAP_DEFAULT_URL = "http://worldserver:7878/";
export const STAGER_ACCOUNT = "STAGER";
/** The env Secret key holding STAGER's password (the chart's `staging.stagerPasswordKey`). */
export const STAGER_PASSWORD_ENV = "WRATHBENCH_STAGER_PASSWORD";
export const SOAP_URL_ENV = "WRATHBENCH_SOAP_URL";

export type SoapRefusal =
  /** 401: the account, or its password, is not what the auth DB holds. */
  | { kind: "unauthorized"; status: 401; message: string }
  /** 403: the account exists but is below SEC_ADMINISTRATOR, so SOAP runs nothing for it. */
  | { kind: "not_admin"; status: 403; message: string }
  /** The command ran and failed; `message` is the command's own output. */
  | { kind: "fault"; status: number; message: string }
  /** Anything else the server said. */
  | { kind: "http"; status: number; message: string }
  /** No answer: refused, reset, timed out. */
  | { kind: "transport"; status: 0; message: string };

export class SoapError extends Error {
  constructor(
    readonly refusal: SoapRefusal,
    readonly command: string,
  ) {
    super(`SOAP ${refusal.kind}${refusal.status ? ` (${refusal.status})` : ""} for '${command}': ${refusal.message}`);
    this.name = "SoapError";
  }
}

export type SoapOptions = {
  url?: string;
  account?: string;
  password: string;
  /** Per command. The CLI queue runs on the world tick; a busy world answers in well under this. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** The request body for one command: the envelope gSOAP's generated stub parses, namespace `urn:AC`. */
export function soapEnvelope(command: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"` +
    ` xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"` +
    ` xmlns:xsi="http://www.w3.org/1999/XMLSchema-instance"` +
    ` xmlns:xsd="http://www.w3.org/1999/XMLSchema" xmlns:ns1="urn:AC">` +
    `<SOAP-ENV:Body><ns1:executeCommand><command>${xmlEscape(command)}</command></ns1:executeCommand></SOAP-ENV:Body>` +
    `</SOAP-ENV:Envelope>`
  );
}

/** The text of the first `<tag>` (any namespace prefix), unescaped; undefined when absent. */
function element(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`).exec(xml);
  if (!m) return undefined;
  return xmlUnescape(m[1] ?? "");
}

/** Read one SOAP response into a result or a refusal. Pure; the tests drive it with a fake server. */
export function parseSoapResponse(status: number, body: string): { ok: true; result: string } | { ok: false; refusal: SoapRefusal } {
  if (status === 401) return { ok: false, refusal: { kind: "unauthorized", status, message: "the SOAP account or its password was refused" } };
  if (status === 403) {
    return { ok: false, refusal: { kind: "not_admin", status, message: "the SOAP account is below SEC_ADMINISTRATOR (gmlevel 3); SOAP runs nothing for it" } };
  }
  const fault = body.includes("Fault>") ? (element(body, "faultstring") ?? element(body, "detail") ?? "") : undefined;
  if (fault !== undefined) return { ok: false, refusal: { kind: "fault", status, message: fault.trim() || "(no fault text)" } };
  if (status === 200) {
    if (!/executeCommandResponse/.test(body)) return { ok: false, refusal: { kind: "http", status, message: `200 without an executeCommandResponse: ${body.slice(0, 200)}` } };
    return { ok: true, result: (element(body, "result") ?? "").trim() };
  }
  return { ok: false, refusal: { kind: "http", status, message: body.slice(0, 200) || "(empty body)" } };
}

export class SoapClient {
  readonly url: string;
  readonly account: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SoapOptions) {
    if (!options.password) throw new Error(`no SOAP password: set ${STAGER_PASSWORD_ENV} (the env Secret's key) for the ${STAGER_ACCOUNT} account`);
    this.url = options.url ?? SOAP_DEFAULT_URL;
    this.account = (options.account ?? STAGER_ACCOUNT).toUpperCase();
    // AzerothCore uppercases both before checking (AccountMgr::CheckPassword).
    this.#authorization = `Basic ${Buffer.from(`${this.account}:${options.password.toUpperCase()}`).toString("base64")}`;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** Run one console command. Resolves with its output; rejects with a SoapError carrying the refusal. */
  async execute(command: string): Promise<string> {
    let res: Response;
    try {
      res = await this.#fetch(this.url, {
        method: "POST",
        headers: { authorization: this.#authorization, "content-type": "text/xml; charset=utf-8", soapaction: '"urn:AC#executeCommand"' },
        body: soapEnvelope(command),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (e) {
      throw new SoapError({ kind: "transport", status: 0, message: e instanceof Error ? e.message : String(e) }, command);
    }
    const parsed = parseSoapResponse(res.status, await res.text().catch(() => ""));
    if (!parsed.ok) throw new SoapError(parsed.refusal, command);
    return parsed.result;
  }

  /**
   * Prove the credential before anything is touched: a read-only console
   * command (`server info`) that every admin may run. A non-admin STAGER is
   * refused here, by name, rather than halfway through a staging.
   */
  async check(): Promise<string> {
    return this.execute(".server info");
  }

  /**
   * `.additem <character> <item> <count>`: `HandleAddItemCommand`, which stores
   * through `Player::StoreNewItem` on the world thread, the live guid generator
   * allocating. The target must be online. A partial store (bags full) still
   * answers success, with "Cannot create item" in the text, so that is read as
   * a failure here; the stager also counts what landed.
   */
  async addItem(character: string, item: number, count = 1): Promise<string> {
    if (!/^[A-Za-z]{2,12}$/.test(character)) throw new Error(`refusing .additem for '${character}': not a character name`);
    if (!Number.isInteger(item) || item <= 0 || !Number.isInteger(count) || count <= 0) throw new Error(`refusing .additem ${item} x${count}`);
    const command = `.additem ${character} ${item} ${count}`;
    const out = await this.execute(command);
    if (/cannot create item/i.test(out)) throw new SoapError({ kind: "fault", status: 200, message: out }, command);
    return out;
  }
}

/** The client the stager uses: URL and password from the environment, never argv. */
export function soapFromEnv(env: Record<string, string | undefined> = process.env): SoapClient {
  const password = env[STAGER_PASSWORD_ENV];
  if (!password) {
    throw new Error(
      `${STAGER_PASSWORD_ENV} is not set: party staging needs the ${STAGER_ACCOUNT} account's password from the env Secret ` +
        `(the chart passes it to the fleet and runner pods when staging.enabled is on; docs/RUNBOOK.md, "Party staging")`,
    );
  }
  return new SoapClient({ url: env[SOAP_URL_ENV] || SOAP_DEFAULT_URL, password });
}
