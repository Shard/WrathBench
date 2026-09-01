import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { ogTags, ogTagsFromEnv } from "./src/lib/og-tags.ts";

/*
 * The dashboard is served two ways and must work identically in both: by Vite
 * in development, proxying `/api` and `/tiles` to a viewer on 8090, and as a
 * static bundle the Bun viewer hosts itself. Same-origin in production is why
 * there is no CORS anywhere.
 *
 * `@viewer/*` reaches into `runner/viewer` for the two modules that are shared
 * rather than duplicated: the API wire types and the world→tile transform.
 * Both are import-free by construction, so nothing server-side follows them in.
 */
const viewerOrigin = process.env["WRATHBENCH_VIEWER_ORIGIN"] ?? "http://127.0.0.1:8090";

/**
 * The social card's origin-dependent `<meta>` tags, injected into the static
 * `index.html` at build time.
 *
 * A crawler reads the HTML with no JavaScript, so the tags cannot come from
 * the app; and `og:image` must be absolute, so they cannot be static either —
 * only the build knows whether it is the public site or the private viewer.
 * `ogTagsFromEnv` answers null for the private build and the placeholder
 * comment is simply dropped. See `src/lib/og-tags.ts`; the picture the tags
 * point at is rendered before the build by `infra/render-og.ts`.
 */
function ogMeta(): Plugin {
  return {
    name: "wrathbench-og-meta",
    transformIndexHtml: (html) => html.replace("<!-- wrathbench:og -->", ogTags(ogTagsFromEnv(process.env))),
  };
}

export default defineConfig({
  plugins: [solid(), ogMeta()],
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
