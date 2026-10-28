/**
 * The sandbox child the runner's host spawns (`host.ts`): the stack's child
 * runtime (`@wrathbench/mcp/sandbox-child`, which documents the whole ambient
 * surface a snippet sees) with the benchmark's extension installed
 * (`child-extension.ts`). Nothing else: what a snippet can reach is the
 * stack's, and the extension adds only what the runner records and renders.
 */

import { startSandboxChild } from "@wrathbench/mcp/sandbox-child";
import { benchmarkChildExtension } from "./child-extension";

startSandboxChild([benchmarkChildExtension]);
