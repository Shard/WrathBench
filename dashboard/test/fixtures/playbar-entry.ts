/**
 * One module graph for the play bar test: the component and the router it
 * renders `A` from, loaded through the same Vite module runner. Loaded any
 * other way the test holds a second copy of the router, and the anchor cannot
 * find the router context the test provides.
 */
export { PlayBar } from "../../src/components/PlayBar";
export { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
