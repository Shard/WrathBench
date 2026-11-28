/**
 * The viewer is a leaf. The runner's core (`runner/src/`) and the collector
 * (`collector/src/`) never import from `viewer/`, type imports
 * included: the viewer deploys alone (viewer.Dockerfile), and the code a model
 * sees (the prompt, the context, the loop) must not move when a viewer module
 * does. The viewer imports from `runner/src/` freely; what both sides read
 * lives there. `importsOf` is the stack boundary's (`stack-boundary.ts`):
 * Bun's scanner for what runs, plus the type-only forms it drops.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { importsOf } from "./stack-boundary";

const ROOT = resolve(import.meta.dir, "..");
const VIEWER = join(ROOT, "viewer");
/** The trees that may not reach into the viewer. */
const GUARDED = ["runner/src", "collector/src"] as const;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** One line per import from a guarded tree into `viewer/`; empty when the boundary holds. */
function viewerImports(): string[] {
  const problems: string[] = [];
  for (const tree of GUARDED) {
    for (const file of walk(join(ROOT, tree))) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (target === VIEWER || target.startsWith(VIEWER + sep)) problems.push(`${relative(ROOT, file)}: imports ${spec}`);
      }
    }
  }
  return problems.sort();
}

describe("the viewer boundary", () => {
  test("runner/src and collector/src import nothing from viewer", () => {
    expect(viewerImports()).toEqual([]);
  });
});

/*
 * A viewer-only process (`WRATHBENCH_GROUPS=viewer`, no admin switch) loads
 * the viewer and nothing of the runner's: `createApi` (`viewer/api.ts`)
 * imports each group's route modules with `import()` only when that group, or
 * the admin switch, is on. This is the module graph such a process loads,
 * built by Bun's own bundler from the bind (`serve.ts`) and walked over every
 * edge but those gates, so an import that works its way back into the
 * process (a static import, a re-export, a dynamic import anywhere else, such
 * as the local store's collector) shows here.
 */
const SERVE = "viewer/serve.ts";
const API = "viewer/api.ts";
/** What `api.ts` imports only with a group or the admin switch on. */
const GATED = [
  "viewer/api-fleet.ts",
  "viewer/api-evals.ts",
  "viewer/config-api.ts",
  "viewer/admin-api.ts",
  "viewer/drafts.ts",
] as const;
/**
 * What a viewer-only process must never load: the agent loop, the drivers,
 * the model's surface, the scheduler, and the other groups' routes.
 */
const FORBIDDEN: readonly RegExp[] = [
  /^runner\/src\/loop\.ts$/,
  /^runner\/src\/adapter/,
  /^runner\/src\/(prompt|tools)\.ts$/,
  /^wrath-mcp\/mcp\/src\/(index|server)\.ts$/,
  // All of the sandbox but the import-free snippet rewriter, which the
  // workspace's file cap (`FILE_MAX_CHARS`, the context policy's) is read beside.
  /^wrath-mcp\/mcp\/src\/sandbox\/(?!rewrite\.ts$)/,
  /^wiki\//,
  // The scheduler: the policy and projection, the config store's write gate
  // and the supervisor's parser behind it, the campaigns, the credential
  // slots and providers, and the trajectory writer. A run's fact, the config
  // store's read and a roster entry's identity are leaves of their own
  // (`run-fact.ts`, `config-read.ts`, `roster-entry.ts`).
  /^runner\/src\/(models|config-store|campaigns|campaign-def|run-flags|credential-slots|providers|roster-refusal|account-pool|model-lists|run-fact-cache|store-secrets|move-credential|trajectory)\.ts$/,
  /^infra\/run-fleet(-config)?\.ts$/,
  // `models.ts` completes the roster for the runner and evals routes; every handle reads `roster.ts`.
  /^viewer\/(admin-api|config-api|drafts|api-fleet|tools|api-evals|campaigns|dungeons|dungeon-marks|models)\.ts$/,
];
/**
 * How many `runner/src` files a viewer-only process reaches, at most. A
 * ceiling, not a target: lower it when a cut lands, and a change that raises
 * it is a change that pulls more of the runner into the viewer. 41 with the
 * dungeon registry (`dungeons.ts`, zod and its data alone), which the
 * timeline's boss marks and the publisher's board read.
 */
const RUNNER_SRC_CEILING = 41;

interface Edge {
  path: string;
  kind: string;
}

async function viewerGraph(): Promise<Map<string, Edge[]>> {
  // `packages: "bundle"`: the stack's workspaces are packages, and leaving them
  // external would hide the MCP server and sandbox behind their names.
  const built = await Bun.build({ entrypoints: [join(ROOT, SERVE)], target: "bun", metafile: true, packages: "bundle" });
  if (!built.success || built.metafile === undefined) throw new Error(`bundling ${SERVE} failed: ${built.logs.join("\n")}`);
  const rel = (p: string): string => relative(ROOT, resolve(process.cwd(), p)).split(sep).join("/");
  const graph = new Map<string, Edge[]>();
  for (const [file, input] of Object.entries(built.metafile.inputs)) {
    graph.set(
      rel(file),
      input.imports.filter((i) => i.external !== true).map((i) => ({ path: rel(i.path), kind: i.kind })),
    );
  }
  return graph;
}

/** Every file reachable from the bind, over every edge `follow` keeps. */
function reach(graph: ReadonlyMap<string, Edge[]>, follow: (from: string, e: Edge) => boolean): Set<string> {
  const seen = new Set([SERVE]);
  const queue = [SERVE];
  for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
    for (const e of graph.get(f) ?? []) {
      if (seen.has(e.path) || !follow(f, e)) continue;
      seen.add(e.path);
      queue.push(e.path);
    }
  }
  return seen;
}

const isGate = (from: string, e: Edge): boolean =>
  from === API && e.kind === "dynamic-import" && (GATED as readonly string[]).includes(e.path);

describe("a viewer-only process", () => {
  test("loads none of the runner, the model's surface or the other groups' routes", async () => {
    const graph = await viewerGraph();
    // The gates are where this test thinks they are: each is a dynamic import in api.ts.
    for (const g of GATED) expect((graph.get(API) ?? []).filter((e) => e.path === g).map((e) => e.kind)).toEqual(["dynamic-import"]);
    // And through them the walk reaches what they hold, so the gates are what keep it out.
    const everything = reach(graph, () => true);
    expect(everything.has("viewer/api-fleet.ts")).toBe(true);
    expect([...everything].some((f) => f.startsWith("wiki/"))).toBe(true);

    const loaded = reach(graph, (from, e) => !isGate(from, e));
    expect([...loaded].filter((f) => FORBIDDEN.some((r) => r.test(f))).sort()).toEqual([]);
    expect([...loaded].filter((f) => f.startsWith("runner/src/")).length).toBeLessThanOrEqual(RUNNER_SRC_CEILING);
  });
});
