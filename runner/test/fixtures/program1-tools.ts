/**
 * The program loop's tool list as a single-character run is served it, with
 * and without `yield`, as one JSON value. `program-fanout.test.ts` holds it
 * byte for byte to `program1-tools.json`, written before the program loop
 * could run at fan-out, so that capability changes nothing for one character.
 */
import { toolsFor } from "../../src/tools";

export function program1Tools(): unknown {
  return {
    program: toolsFor({ programTools: { yield: false } }),
    yield: toolsFor({ programTools: { yield: true } }),
    noWiki: toolsFor({ programTools: { yield: false }, wikiSearch: false }),
    coords: toolsFor({ programTools: { yield: false }, wikiCoords: true }),
  };
}
