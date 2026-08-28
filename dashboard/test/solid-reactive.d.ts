/**
 * `bun test` resolves `solid-js` under the node condition, which is the server
 * build: signals there never notify, so a test of the reactive graph would pass
 * against it no matter what the graph did. `test/preload-solid.ts` reaches for
 * the browser build by path instead — which the package exports but does not
 * type, so the types are borrowed from the package's own entry point here.
 */
declare module "solid-js/dist/solid.js" {
  export * from "solid-js";
}
