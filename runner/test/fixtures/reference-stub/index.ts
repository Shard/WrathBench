/**
 * A stand-in reference program for the hook's tests: the export shape the
 * real one has (runner/src/reference-program.ts), with a three-step route and
 * a tick that plays nothing. It walks the steps, notes each in the
 * scratchpad, and never finishes its last one, as the real route's hunt does.
 */
import type { ReferenceEnv, TickArgs, TickReport } from "../../../src/reference-adapter";
import type { ReferenceProgram, ReferenceRoute } from "../../../src/reference-program";

export const STUB_ROUTE: ReferenceRoute = {
  id: "stub-route",
  version: 1,
  race: 1,
  class: 2,
  steps: [{ kind: "walk" }, { kind: "talk" }, { kind: "hunt" }],
};

async function stubTick(env: ReferenceEnv, route: ReferenceRoute, args: TickArgs): Promise<TickReport> {
  const step = route.steps[args.cursor]!;
  await env.scratchpad.write(`stub-cursor: ${args.cursor}`);
  return { v: 1, cursor: args.cursor, advance: args.cursor < route.steps.length - 1, did: [`${step.kind} ${args.cursor}`] };
}

export const program: ReferenceProgram = { route: STUB_ROUTE, source: stubTick.toString() };
