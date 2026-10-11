/**
 * One module graph for the campaigns page render test: the page and the router
 * it reads its params from, loaded through the same Vite module runner (see
 * `playbar-entry.ts` for why a second copy of the router cannot work).
 */
export { default as Campaigns } from "../../src/pages/Campaigns";
export { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
