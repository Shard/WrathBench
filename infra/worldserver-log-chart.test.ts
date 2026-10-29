/**
 * The worldserver's console log in the chart (templates/worldserver.yaml):
 * every line reaches `kubectl logs` once. The stock conf has two appenders a
 * logger can name, `Console` and `Server`, and most loggers name both; the
 * chart makes `Server` the one console appender, turns `Console` off, and
 * re-points the loggers that named `Console` alone. The first half pins the
 * rendered env; the second, when the pinned core is checked out (CI checks
 * out only wrath-mcp), applies that env to the core's own Logger section and
 * counts, per logger, the enabled console appenders it writes to, so a core
 * bump that adds a Console-only logger fails here rather than in the cluster.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const chart = join(import.meta.dir, "chart", "wrathbench");
const dist = join(import.meta.dir, "..", "deps", "azerothcore", "src", "server", "apps", "worldserver", "worldserver.conf.dist");
const helm = Bun.which("helm");
const HELM_TEST_MS = 30_000;
const BASE = ["--namespace", "wrathbench", "--set", "image.registry=harbor.example/wrathbench", "--set", "image.tag=harness-0.5-1-gabcdef0"];

/** The logging env the chart sets on the worldserver, exactly. */
const LOG_ENV: Record<string, string> = {
  AC_APPENDER_SERVER: "1,5,0",
  AC_APPENDER_CONSOLE: "1,0,0",
  AC_LOGGER_SQL_SQL: "2,Server Errors",
  AC_LOGGER_SPELLS_SCRIPTS: "2,Server Errors",
};

type Env = { name: string; value?: string };
type Doc = { kind?: string; metadata?: { name?: string }; spec?: { template?: { spec?: { containers?: { name: string; env?: Env[] }[] } } } } | null;

function worldserverEnv(): Record<string, string | undefined> {
  const r = Bun.spawnSync([helm!, "template", "wrathbench", chart, ...BASE], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const docs = r.stdout.toString().split(/^---$/m).map((d) => Bun.YAML.parse(d) as Doc);
  const ws = docs.find((d) => d?.kind === "Deployment" && d.metadata?.name === "wrathbench-worldserver");
  const c = ws!.spec!.template!.spec!.containers!.find((x) => x.name === "worldserver")!;
  return Object.fromEntries((c.env ?? []).map((e) => [e.name, e.value]));
}

/** AzerothCore's conf key → env name (Config.cpp IniKeyToEnvVarKey), for the dotted lower-case keys used here. */
const envName = (key: string) => "AC_" + key.replace(/\./g, "_").toUpperCase();

describe.skipIf(helm === null)("the chart's worldserver log env", () => {
  test("Server is the one console appender, Console is off, the Console-only loggers point at Server, and nothing else is set", () => {
    const env = worldserverEnv();
    const logging = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("AC_APPENDER_") || k.startsWith("AC_LOGGER_")));
    expect(logging).toEqual(LOG_ENV);
  }, HELM_TEST_MS);
});

describe.skipIf(!existsSync(dist))("the pinned core's loggers under the chart's env", () => {
  test("every logger reaches exactly one enabled console appender", () => {
    const conf = new Map<string, string>();
    for (const line of readFileSync(dist, "utf8").split("\n")) {
      const m = /^((?:Appender|Logger)\.[^=\s]+)\s*=\s*(.*)$/.exec(line);
      if (m) conf.set(m[1]!, m[2]!.trim());
    }
    // The env overrides only keys the conf already has (Config.cpp
    // OverrideWithEnvVariablesIfAny), so every key the chart sets must exist.
    const keyed = new Map([...conf.keys()].map((k) => [envName(k), k]));
    for (const name of Object.keys(LOG_ENV)) expect(keyed.has(name), `${name} names a key in the stock conf`).toBe(true);
    for (const [name, value] of Object.entries(LOG_ENV)) conf.set(keyed.get(name)!, value);

    // Appender.<name>=Type,Level,Flags[,...]: type 1 is Console, level 0 writes nothing.
    const consoles = new Set<string>();
    for (const [key, value] of conf) {
      if (!key.startsWith("Appender.")) continue;
      const [type, level] = value.split(",").map((s) => s.trim());
      if (type === "1" && level !== "0") consoles.add(key.slice("Appender.".length));
    }
    expect([...consoles]).toEqual(["Server"]);

    const loggers = [...conf].filter(([k]) => k.startsWith("Logger."));
    expect(loggers.length).toBeGreaterThan(0);
    for (const [key, value] of loggers) {
      const [level, appenders = ""] = value.split(",");
      if (level!.trim() === "0") continue;
      const toConsole = appenders.trim().split(/\s+/).filter((a) => consoles.has(a));
      expect(toConsole, key).toEqual(["Server"]);
    }
  });
});
