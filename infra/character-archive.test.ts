/**
 * The character archive's real game half (`SoapGameSide`), against a fake
 * SOAP console that plays the worldserver's part: the exact `.pdump` console
 * lines, the exchange file through the shared directory and gone afterwards,
 * and the refusals. The archive itself is runner/test/character-archive.test.ts.
 * Nothing here reaches a database or a server.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";
import { CharacterArchiveRefused } from "../runner/src/character-archive";
import { tempDirs } from "../runner/test/fixtures/temp-dirs";
import { SoapGameSide } from "./character-archive";
import { SoapError } from "./fixtures/soap.ts";

const tempDir = tempDirs();
const SERVER = "/srv/characters/pdump";
const DUMP = Buffer.concat([Buffer.from("IMPORTANT NOTE: …\n\nINSERT INTO `characters` VALUES ('57','2','Brenna','"), Buffer.from([0xff, 0x80]), Buffer.from("');\n")]);

/** A worldserver that sees `SERVER` where this process sees `local`. */
function fakeServer(local: string, reply: (command: string, file: string | null) => string = () => "") {
  const commands: string[] = [];
  const seen: (Buffer | null)[] = [];
  const soap = {
    execute: async (command: string): Promise<string> => {
      commands.push(command);
      const path = command.split(" ")[2] ?? "";
      const file = path.startsWith(`${SERVER}/`) ? join(local, path.slice(SERVER.length + 1)) : null;
      seen.push(file !== null && existsSync(file) ? readFileSync(file) : null);
      return reply(command, file);
    },
  };
  return { soap, commands, seen };
}

const game = (local: string, soap: { execute: (c: string) => Promise<string> }) =>
  new SoapGameSide({ soap, auth: {} as SQL, chars: {} as SQL, localDir: local, serverDir: SERVER });

describe("SoapGameSide", () => {
  test("dump: `.pdump write <server path> <name>`, read through the shared directory, then removed", async () => {
    const local = join(tempDir("wb-pdump-"), "pdump");
    const s = fakeServer(local, (command, file) => {
      if (command.startsWith(".pdump write") && file !== null) writeFileSync(file, DUMP);
      return "Character dumped successfully.";
    });
    expect(Buffer.from(await game(local, s.soap).dump("Brenna")).equals(DUMP)).toBe(true);
    expect(s.commands).toHaveLength(1);
    expect(s.commands[0]).toMatch(new RegExp(`^\\.pdump write ${SERVER}/\\d+-[0-9a-f]{12}\\.pdump Brenna$`));
    expect(readdirSync(local)).toEqual([]);
  });

  test("load: the dump is in the shared directory while `.pdump load <file> <account> <name> <guid>` runs, and gone after", async () => {
    const local = join(tempDir("wb-pdump-"), "pdump");
    const s = fakeServer(local, () => "Character imported successfully.");
    await game(local, s.soap).load(DUMP, "RUNNER3", "Brenna", 57);
    expect(s.commands[0]).toMatch(new RegExp(`^\\.pdump load ${SERVER}/\\d+-[0-9a-f]{12}\\.pdump RUNNER3 Brenna 57$`));
    expect(s.seen).toEqual([DUMP]);
    expect(readdirSync(local)).toEqual([]);
  });

  test("a SOAP fault is a refusal in the server's own words; and nothing a console line could be split on is sent", async () => {
    const local = join(tempDir("wb-pdump-"), "pdump");
    const failing = {
      execute: async (command: string): Promise<string> => {
        throw new SoapError({ kind: "fault", status: 500, message: "Account not exist: RUNNER9" }, command);
      },
    };
    const msg = await game(local, failing)
      .load(DUMP, "RUNNER9", "Brenna", 57)
      .then(() => "")
      .catch((e: Error) => e);
    expect(msg).toBeInstanceOf(CharacterArchiveRefused);
    expect((msg as Error).message).toBe("the server refused '.pdump load': Account not exist: RUNNER9");
    expect(readdirSync(local)).toEqual([]);

    const s = fakeServer(local);
    const g = game(local, s.soap);
    for (const p of [g.dump("Brenna .server shutdown 1"), g.load(DUMP, "RUNNER2 x", "Brenna", 57), g.load(DUMP, "RUNNER2", "Bre nna", 57), g.load(DUMP, "RUNNER2", "Brenna", 0)]) {
      expect(await p.then(() => null).catch((e: unknown) => e)).toBeInstanceOf(CharacterArchiveRefused);
    }
    expect(s.commands).toEqual([]);
  });
});

