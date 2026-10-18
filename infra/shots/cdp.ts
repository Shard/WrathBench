/**
 * Headless Chromium over the DevTools protocol, with Bun's own WebSocket and
 * nothing else: the few verbs the dashboard render rig needs (open a page at a
 * viewport and colour scheme, go, wait for a selector, evaluate, click, take a
 * screenshot), and every third-party request answered here.
 *
 * Third parties: a request to anything but loopback is failed, except
 * Wowhead's tooltip script, which is answered with an empty stub by default so
 * that every page renders the way it does where the script is blocked (a quest
 * reads `quest <id>`, an item its sheet name). `wowhead: "real"` lets the
 * script and its tooltip service through instead. What was stubbed or refused
 * is kept per page, for the rig's facts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WOWHEAD_SCRIPT = "https://wow.zamimg.com/js/tooltips.js";
const WOWHEAD_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(zamimg\.com|wowhead\.com)\//;
const LOOPBACK = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

type Json = Record<string, unknown>;
type Listener = (method: string, params: Json, sessionId: string | undefined) => void;

class Connection {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<Listener>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: Json; error?: { message: string }; method?: string; params?: Json; sessionId?: string };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result ?? {});
      } else if (msg.method !== undefined) {
        for (const l of this.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
      }
    };
  }

  static async open(url: string): Promise<Connection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not reach the browser at ${url}`));
    });
    return new Connection(ws);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) }));
    });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    this.ws.close();
  }
}

export interface PageOptions {
  width: number;
  height: number;
  /** Device pixels per CSS pixel; 2 below 600 px wide by default, as a phone. */
  scale?: number;
  scheme?: "dark" | "light";
  wowhead?: "stub" | "real";
}

export interface PageFacts {
  /** Uncaught exceptions on the page. */
  errors: string[];
  /** console.error lines. */
  console: string[];
  /** Third-party requests: `stubbed <url>`, `refused <url>` or `passed <url>`. */
  thirdParty: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Page {
  readonly facts: PageFacts = { errors: [], console: [], thirdParty: [] };
  private loaded: (() => void) | null = null;

  constructor(
    private readonly conn: Connection,
    private readonly sessionId: string,
    private readonly targetId: string,
    private readonly opts: PageOptions,
  ) {}

  /** @internal */
  async setUp(): Promise<void> {
    const s = this.sessionId;
    const wowhead = this.opts.wowhead ?? "stub";
    this.conn.on((method, params, sessionId) => {
      if (sessionId !== s) return;
      if (method === "Fetch.requestPaused") void this.answer(params, wowhead);
      else if (method === "Runtime.exceptionThrown") {
        const d = params["exceptionDetails"] as { text?: string; exception?: { description?: string } } | undefined;
        this.facts.errors.push(String(d?.exception?.description ?? d?.text ?? "exception").split("\n")[0]!.slice(0, 300));
      } else if (method === "Runtime.consoleAPICalled" && params["type"] === "error") {
        const args = (params["args"] as { value?: unknown; description?: string }[] | undefined) ?? [];
        this.facts.console.push(args.map((a) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 300));
      } else if (method === "Page.loadEventFired") this.loaded?.();
    });
    const scale = this.opts.scale ?? (this.opts.width < 600 ? 2 : 1);
    await Promise.all([
      this.conn.send("Page.enable", {}, s),
      this.conn.send("Runtime.enable", {}, s),
      this.conn.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s),
      this.conn.send("Emulation.setDeviceMetricsOverride", { width: this.opts.width, height: this.opts.height, deviceScaleFactor: scale, mobile: this.opts.width < 600 }, s),
      this.conn.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: this.opts.scheme ?? "dark" }] }, s),
    ]);
  }

  private async answer(params: Json, wowhead: "stub" | "real"): Promise<void> {
    const requestId = params["requestId"] as string;
    const url = (params["request"] as { url: string }).url;
    const s = this.sessionId;
    try {
      if (LOOPBACK.test(url) || url.startsWith("data:") || url.startsWith("blob:")) {
        await this.conn.send("Fetch.continueRequest", { requestId }, s);
      } else if (wowhead === "real" && WOWHEAD_HOSTS.test(url)) {
        this.facts.thirdParty.push(`passed ${url}`);
        await this.conn.send("Fetch.continueRequest", { requestId }, s);
      } else if (url.split("?")[0] === WOWHEAD_SCRIPT) {
        this.facts.thirdParty.push(`stubbed ${url}`);
        const body = Buffer.from("/* the render rig's stand-in for Wowhead's tooltip script */\n").toString("base64");
        await this.conn.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/javascript" }], body }, s);
      } else {
        this.facts.thirdParty.push(`refused ${url}`);
        await this.conn.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, s);
      }
    } catch {
      /* the page went away mid-request */
    }
  }

  /** Navigate and wait for the load event. */
  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      this.loaded = resolve;
    });
    await this.conn.send("Page.navigate", { url }, this.sessionId);
    await Promise.race([loaded, sleep(timeoutMs)]);
    this.loaded = null;
  }

  /** Evaluate an expression in the page; promises are awaited, the value comes back by value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = (await this.conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId)) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (r.exceptionDetails !== undefined) throw new Error(`in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  /** Wait until `selector` matches; false on timeout. */
  async waitFor(selector: string, timeoutMs = 15_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.eval<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await sleep(100);
    }
    return false;
  }

  /** The centre of the first element `selector` matches, in CSS pixels; null when there is none. */
  async centre(selector: string): Promise<{ x: number; y: number } | null> {
    return await this.eval<{ x: number; y: number } | null>(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
  }

  /** A real mouse click at a point. */
  async clickAt(x: number, y: number): Promise<void> {
    const s = this.sessionId;
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, s);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, s);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, s);
  }

  /** Click the first element `selector` matches; false when there is none. */
  async click(selector: string): Promise<boolean> {
    const c = await this.centre(selector);
    if (c === null) return false;
    await this.clickAt(c.x, c.y);
    return true;
  }

  /** Move the mouse, for hover states. */
  async hover(x: number, y: number): Promise<void> {
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.sessionId);
  }

  /** A wheel turn at a point: negative `deltaY` zooms the map in. */
  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }, this.sessionId);
  }

  /** A PNG of the viewport, or of the first element `selector` matches. */
  async screenshot(path: string, selector?: string): Promise<void> {
    let clip: Json | undefined;
    if (selector !== undefined) {
      const r = await this.eval<{ x: number; y: number; width: number; height: number } | null>(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
      );
      if (r !== null && r.width > 0 && r.height > 0) clip = { ...r, scale: 1 };
    }
    const shot = (await this.conn.send("Page.captureScreenshot", { format: "png", ...(clip !== undefined ? { clip, captureBeyondViewport: true } : {}) }, this.sessionId)) as { data: string };
    await Bun.write(path, Buffer.from(shot.data, "base64"));
  }

  async close(): Promise<void> {
    try {
      await this.conn.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      /* gone already */
    }
  }
}

export interface Browser {
  newPage(opts: PageOptions): Promise<Page>;
  close(): Promise<void>;
}

/** The first Chromium on the PATH, or WRATHBENCH_CHROMIUM. */
export function findChromium(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env["WRATHBENCH_CHROMIUM"]) return env["WRATHBENCH_CHROMIUM"]!;
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }
  return null;
}

/** Launch a headless Chromium with a throwaway profile and connect to it. */
export async function launch(executable: string): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "wb-shots-chrome-"));
  const proc = Bun.spawn(
    [
      executable,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let wsUrl: string | null = null;
  for (let i = 0; i < 100 && wsUrl === null; i++) {
    try {
      const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      if (port && path) wsUrl = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    } catch {
      await sleep(100);
    }
  }
  if (wsUrl === null) {
    proc.kill();
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`${executable} did not open its DevTools port`);
  }
  const conn = await Connection.open(wsUrl);
  return {
    async newPage(opts) {
      const { targetId } = (await conn.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
      const { sessionId } = (await conn.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      const page = new Page(conn, sessionId, targetId, opts);
      await page.setUp();
      return page;
    },
    async close() {
      try {
        await conn.send("Browser.close");
      } catch {
        /* already closing */
      }
      conn.close();
      proc.kill();
      await proc.exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
