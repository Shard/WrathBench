/**
 * One module graph for the runs page render test: the page, the router it reads
 * its params from and the shell's feeds context it reads the series from, loaded
 * through the same Vite module runner (see `playbar-entry.ts` for why a second
 * copy of the router cannot work; a second copy of the context would be a
 * different context).
 */
export { default as Runs } from "../../src/pages/Runs";
export { FeedsContext } from "../../src/lib/feeds";
export { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
