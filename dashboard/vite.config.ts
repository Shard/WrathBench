import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import type { ModelCatalogue } from "../infra/model-catalogue.ts";
import { clientCatalogue } from "./src/lib/catalogue-subset.ts";
import { dataHints } from "./src/lib/data-hints.ts";
import { ogTags, ogTagsFromEnv } from "./src/lib/og-tags.ts";

/*
 * The dashboard is served two ways and must work identically in both: by Vite
 * in development, proxying `/api` and `/tiles` to a viewer on 8090, and as a
 * static bundle the Bun viewer hosts itself. Same-origin in production is why
 * there is no CORS anywhere.
 *
 * `@viewer/*` reaches into `runner/viewer` for the ten modules that are
 * shared rather than duplicated: the API wire types, the world→tile transform
 * (with the names of the maps that have tiles),
 * the freeplay lineage walk, the character aggregation over it, a run's
 * sessions, the public projection's allowlist, the race and class names, the
 * trace codec, the nearby codec and the tile index. All ten are import-free
 * by construction (the wire types take one type from the import-free driver
 * registry, and the tile index its grid from the world→tile transform), so
 * nothing server-side follows them in.
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
    transformIndexHtml: (html) =>
      html
        .replace("<!-- wrathbench:og -->", ogTags(ogTagsFromEnv(process.env)))
        // The data host's preconnect and manifest preload, public build only
        // (`src/lib/data-hints.ts`).
        .replace("<!-- wrathbench:data -->", dataHints(process.env["VITE_WRATHBENCH_SNAPSHOT_BASE"])),
  };
}

const CATALOGUE_FILE =resolve(import.meta.dirname, "../infra/model-catalogue.json");

/**
 * The model catalogue as the browser gets it. `infra/model-catalogue.ts`
 * imports the whole file, prices, notes and sources included, and all of it
 * used to ship in the chunk every page with a model logo loads. The app reads
 * only the lookup's fields, so the bundle gets `clientCatalogue`'s subset in
 * place of the file (`src/lib/catalogue-subset.ts`): derived at each build, so
 * there is nothing to regenerate and nothing to drift.
 */
function catalogueSubset(): Plugin {
  return {
    name: "wrathbench-catalogue-subset",
    enforce: "pre",
    load(id) {
      if (id.split("?")[0] !== CATALOGUE_FILE) return null;
      return JSON.stringify(clientCatalogue(JSON.parse(readFileSync(CATALOGUE_FILE, "utf8")) as ModelCatalogue));
    },
  };
}

export default defineConfig({
  plugins: [solid(), ogMeta(), catalogueSubset()],
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
