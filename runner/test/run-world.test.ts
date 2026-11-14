/**
 * The run's world (`config.world`): read at a fresh launch from the pointer
 * its launcher left beside it, `shared` without one; identity through a
 * resume's reload; a label the run fact carries, never a key.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFromArgs } from "../src/run";
import { runConfigSchema } from "../src/config";
import { readRunFact } from "../src/models";
import { tempDirs } from "./fixtures/temp-dirs";
import { openSessionRecord } from "../src/session-record";
import type { SessionFile } from "@wrathbench/mcp/record";
import { readFileSync } from "node:fs";

const tempDir = tempDirs();
const ID = "wabcdefghij";

describe("config.world", () => {
  test("a fresh launch takes its launcher's pointer, and the shared world without one", () => {
    const runs = tempDir("wb-run-world-");
    mkdirSync(join(runs, "r-eval"), { recursive: true });
    writeFileSync(join(runs, "r-eval", "world.json"), JSON.stringify({ id: ID }));
    expect(configFromArgs(["--model", "m", "--run-id", "r-eval", "--runs-dir", runs]).world).toBe(ID);
    expect(configFromArgs(["--model", "m", "--run-id", "r-free", "--runs-dir", runs]).world).toBe("shared");
    // A pointer that names no world is no world.
    mkdirSync(join(runs, "r-bad"), { recursive: true });
    writeFileSync(join(runs, "r-bad", "world.json"), JSON.stringify({ id: "w0abcdefghj" }));
    expect(configFromArgs(["--model", "m", "--run-id", "r-bad", "--runs-dir", runs]).world).toBe("shared");
  });

  test("the schema keeps it through a resume's reload, and refuses anything that is not a world", () => {
    expect(runConfigSchema.parse({ model: "m", world: ID }).world).toBe(ID);
    expect(runConfigSchema.parse({ model: "m", world: "shared" }).world).toBe("shared");
    expect(runConfigSchema.parse({ model: "m" }).world).toBeUndefined();
    expect(() => runConfigSchema.parse({ model: "m", world: "acore_characters" })).toThrow();
  });

  test("the run fact carries it as a label, null before worlds", () => {
    const runs = tempDir("wb-run-world-fact-");
    const meta = (id: string, config: object) => {
      mkdirSync(join(runs, id), { recursive: true });
      writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ runId: id, harnessVersion: "harness-1.0-1-gabc", startedAt: 1, comparability: { episode: "e90" }, config: { model: "m", ...config } }));
    };
    meta("on-world", { world: ID });
    meta("before", {});
    expect(readRunFact(runs, "on-world")!.world).toBe(ID);
    expect(readRunFact(runs, "before")!.world).toBeNull();
  });

  test("session.json names a world of its own, and nothing on the shared world", async () => {
    const runs = tempDir("wb-run-world-session-");
    const open = (run: string, world?: string): SessionFile => {
      const { writer } = openSessionRecord({ runDir: join(runs, run), runsDir: runs, ...(world !== undefined ? { world } : {}), token: `tok-${run}-world-invented-token-0123456789`, scrub: (t) => t });
      void writer.close();
      return JSON.parse(readFileSync(join(runs, run, "session", "session.json"), "utf8")) as SessionFile;
    };
    expect(open("on-world", ID).world).toBe(ID);
    expect(open("shared", "shared")).not.toHaveProperty("world");
    // No option: the run's pointer says it.
    mkdirSync(join(runs, "pointed"), { recursive: true });
    writeFileSync(join(runs, "pointed", "world.json"), JSON.stringify({ id: ID }));
    expect(open("pointed").world).toBe(ID);
  });
});
