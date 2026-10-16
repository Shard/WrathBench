/**
 * The persistent fixture characters' default names. Character names are
 * realm-global, so `achievements-taxi`'s old fixed `Smoketaxi` collided with
 * the copy already standing on PROBE when SMOKE2 ran it (create code 50). The
 * name now follows the account, as the preflight gate's always did.
 */
import { describe, expect, test } from "bun:test";
import { isValidCharacterName } from "../runner/src/config";
import { accountFixtureName } from "./smoke/lib/fixture";

describe("accountFixtureName", () => {
  test("two accounts get two names, each a name the game accepts", () => {
    const probe = accountFixtureName("Tx", "PROBE");
    const smoke2 = accountFixtureName("Tx", "SMOKE2");
    expect(probe).toBe("Txprobe");
    expect(smoke2).toBe("Txsmokec");
    expect(probe).not.toBe(smoke2);
    expect(isValidCharacterName(probe) && isValidCharacterName(smoke2)).toBe(true);
  });

  test("the preflight gate's names are unchanged", () => {
    expect(accountFixtureName("Pf", "SMOKE3")).toBe("Pfsmoked");
    expect(accountFixtureName("Pf", "PROBE")).toBe("Pfprobe");
  });

  test("capped at twelve letters, and never three identical in a row", () => {
    expect(accountFixtureName("Tx", "A-VERY-LONG-ACCOUNT-NAME")).toHaveLength(12);
    const triple = accountFixtureName("Tx", "SMOKE222");
    expect(triple).toBe("Txsmokecc");
    expect(isValidCharacterName(triple)).toBe(true);
    expect(isValidCharacterName(accountFixtureName("Tx", "XXX"))).toBe(true);
  });
});
