/**
 * A Codex home's re-auth from the admin page (runner/src/codex-login.ts),
 * against a fake `codex` that prints what 0.153's `login --device-auth`
 * prints, colour codes and all. Never the real CLI, never OpenAI.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "../src/credential-slots";
import { CodexLogins, effectiveCodexLogin, parseDeviceAuth, readCodexLogin, readCodexLoginRequest, requestCodexLogin } from "../src/codex-login";
import { STORE_KEY_ENV } from "../src/store-secrets";
import { KEY_HEX, SENTINEL } from "./fixtures/store-secrets";
import { tempDirs } from "./fixtures/temp-dirs";

const tempDir = tempDirs();

/** What `codex login --device-auth` (0.153.4) wrote to stdout, verbatim but for the code. */
const DEVICE_AUTH_STDOUT = [
  "",
  "Welcome to Codex [v\u001b[90m0.153.4\u001b[0m]",
  "\u001b[90mOpenAI's command-line coding agent\u001b[0m",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
  "",
  "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
  "   \u001b[94mABCD-EFG12\u001b[0m",
  "",
  "\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m",
  "",
];

/** A fake CLI: prints the lines, records its environment, waits for `.go`, then does what `.mode` says. */
function fakeCodex(dir: string): string {
  const out = join(dir, "stdout.txt");
  writeFileSync(out, DEVICE_AUTH_STDOUT.join("\n") + "\n");
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/bin/sh
[ "$1 $2" = "login --device-auth" ] || exit 9
cat '${out}'
env > "$CODEX_HOME/.fake-env"
while [ ! -f "$CODEX_HOME/.go" ]; do sleep 0.02; done
case "$(cat "$CODEX_HOME/.mode" 2>/dev/null)" in
  ok) echo '{}' > "$CODEX_HOME/auth.json"; exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const cred = (id: string, provider: string, secretEnv: string, enabled = false): Credential => ({ id, provider, secretEnv, slots: 1, budget: null, billing: "paid", enabled });

function rig(o: { inUse?: number; ttlMs?: number } = {}) {
  const root = tempDir("codex-login-");
  const home = join(root, "home");
  mkdirSync(home);
  const dir = join(root, "codex-login");
  const lines: string[] = [];
  const env = { PATH: process.env["PATH"], HOME: root, CODEX_HOME: home, OPENROUTER_KEY: SENTINEL, [STORE_KEY_ENV]: KEY_HEX, WRATHBENCH_MODULE_SECRET: SENTINEL };
  const logins = new CodexLogins({
    credentials: () => [cred("chatgpt-1", "chatgpt", "CODEX_HOME"), cred("or-1", "openrouter", "OPENROUTER_KEY"), cred("chatgpt-on", "chatgpt", "CODEX_HOME", true)],
    inUse: () => o.inUse ?? 0,
    env,
    dir,
    bin: fakeCodex(root),
    say: (l) => void lines.push(l),
    ...(o.ttlMs !== undefined ? { ttlMs: o.ttlMs } : {}),
  });
  return { root, home, dir, lines, logins };
}

const until = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};

describe("parseDeviceAuth", () => {
  test("the link and the code, colour codes stripped", () => {
    expect(parseDeviceAuth(DEVICE_AUTH_STDOUT)).toEqual({ url: "https://auth.openai.com/codex/device", code: "ABCD-EFG12" });
    expect(parseDeviceAuth(DEVICE_AUTH_STDOUT.slice(0, 9))).toEqual({ url: "https://auth.openai.com/codex/device" });
  });
});

describe("CodexLogins", () => {
  test("a request runs the login: the link and code, then logged in; the CLI gets no secret of the fleet's", async () => {
    const r = rig();
    expect(requestCodexLogin(r.dir, "chatgpt-1", "mark")).toEqual({ ok: true });
    const [done] = r.logins.poll();
    expect(done).toBeDefined();
    await until(() => readCodexLogin(r.dir, "chatgpt-1")?.state === "waiting");
    expect(readCodexLogin(r.dir, "chatgpt-1")).toMatchObject({ state: "waiting", actor: "mark", url: "https://auth.openai.com/codex/device", code: "ABCD-EFG12" });
    // One login per home: a second request while this one waits is refused.
    expect(requestCodexLogin(r.dir, "chatgpt-1", "mark").ok).toBe(false);
    writeFileSync(join(r.home, ".mode"), "ok");
    writeFileSync(join(r.home, ".go"), "");
    await done;
    expect(readCodexLogin(r.dir, "chatgpt-1")).toMatchObject({ state: "ok" });
    expect(existsSync(join(r.home, "auth.json"))).toBe(true);
    const childEnv = readFileSync(join(r.home, ".fake-env"), "utf8");
    expect(childEnv).not.toContain("SENTINEL");
    expect(childEnv).not.toContain(STORE_KEY_ENV);
    expect(childEnv).toContain(`CODEX_HOME=${r.home}`);
    // The code is the page's, never the log's.
    expect(r.lines.join("\n")).not.toContain("ABCD-EFG12");
  });

  test("a failed login reads failed, with the exit and not the CLI's words", async () => {
    const r = rig();
    requestCodexLogin(r.dir, "chatgpt-1", "mark");
    const [done] = r.logins.poll();
    writeFileSync(join(r.home, ".go"), "");
    await done;
    expect(readCodexLogin(r.dir, "chatgpt-1")).toMatchObject({ state: "failed", detail: "codex login exited 1" });
  });

  test("a code nobody enters expires, and the CLI is stopped", async () => {
    const r = rig({ ttlMs: 200 });
    requestCodexLogin(r.dir, "chatgpt-1", "mark");
    const [done] = r.logins.poll();
    await done;
    expect(readCodexLogin(r.dir, "chatgpt-1")).toMatchObject({ state: "failed", detail: "the code expired before it was entered" });
  });

  test("refused while a run is live on it, for an endpoint credential, for an unknown one", () => {
    const busy = rig({ inUse: 1 });
    requestCodexLogin(busy.dir, "chatgpt-1", "mark");
    expect(busy.logins.poll()).toEqual([]);
    expect(readCodexLogin(busy.dir, "chatgpt-1")?.detail).toContain("live on chatgpt-1");

    const r = rig();
    requestCodexLogin(r.dir, "chatgpt-on", "mark");
    expect(r.logins.poll()).toEqual([]);
    expect(readCodexLogin(r.dir, "chatgpt-on")?.detail).toContain("disable it first");
    requestCodexLogin(r.dir, "or-1", "mark");
    requestCodexLogin(r.dir, "ghost", "mark");
    expect(r.logins.poll()).toEqual([]);
    expect(readCodexLogin(r.dir, "or-1")?.detail).toContain("not a Codex home");
    expect(readCodexLogin(r.dir, "ghost")?.detail).toContain("no credential ghost");
    // Each request is answered once.
    expect(r.logins.poll()).toEqual([]);
  });
});

describe("a login nobody finishes", () => {
  test("a state a stopped supervisor left reads failed, and a new supervisor says so; a request it never took can be asked again", () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(r.dir, "chatgpt-1.state.json"), JSON.stringify({ state: "waiting", requestedAt: now - 20 * 60_000, at: now - 19 * 60_000, actor: "mark", url: "https://x", code: "ABCD-EFGH" }));
    expect(effectiveCodexLogin(readCodexLogin(r.dir, "chatgpt-1"), now)).toMatchObject({ state: "failed" });
    expect(effectiveCodexLogin(readCodexLogin(r.dir, "chatgpt-1"), now)?.code).toBeUndefined();
    // A fresh one under way stays as it is.
    writeFileSync(join(r.dir, "chatgpt-1.state.json"), JSON.stringify({ state: "waiting", requestedAt: now - 60_000, at: now, actor: "mark", url: "https://x", code: "ABCD-EFGH" }));
    expect(effectiveCodexLogin(readCodexLogin(r.dir, "chatgpt-1"), now)?.state).toBe("waiting");
    // A supervisor starting over finds it and fails it.
    new CodexLogins({ credentials: () => [], inUse: () => 0, dir: r.dir });
    expect(readCodexLogin(r.dir, "chatgpt-1")).toMatchObject({ state: "failed", detail: "the supervisor restarted during it" });
    // A request older than a minute no longer blocks a new one.
    writeFileSync(join(r.dir, "chatgpt-1.request.json"), JSON.stringify({ at: now - 5 * 60_000, actor: "mark" }));
    expect(readCodexLoginRequest(r.dir, "chatgpt-1", now)?.stale).toBe(true);
    expect(requestCodexLogin(r.dir, "chatgpt-1", "mark", now)).toEqual({ ok: true });
    expect(requestCodexLogin(r.dir, "chatgpt-1", "mark", now).ok).toBe(false);
  });
});
