import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/*
 * The dashboard is served two ways and must work identically in both: by Vite
 * in development, proxying `/api` and `/tiles` to a viewer on 8090, and as a
 * static bundle the Bun viewer hosts itself. Same-origin in production is why
 * there is no CORS anywhere (ADR-0021).
 *
 * `@viewer/*` reaches into `runner/viewer` for the two modules that are shared
 * rather than duplicated: the API wire types and the world→tile transform.
 * Both are import-free by construction, so nothing server-side follows them in.
 */
const viewerOrigin = process.env["WRATHBENCH_VIEWER_ORIGIN"] ?? "http://127.0.0.1:8090";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: { "@viewer": resolve(import.meta.dirname, "../runner/viewer") },
  },
  server: {
    port: 5180,
    // The shared modules live above the Vite root.
    fs: { allow: [resolve(import.meta.dirname, ".."), resolve(import.meta.dirname)] },
    proxy: {
      "/api": { target: viewerOrigin, changeOrigin: false },
      "/tiles": { target: viewerOrigin, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
