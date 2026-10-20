/**
 * The party smokes' route walk (infra/smoke/lib/party.ts, `walkRoute`): one
 * move per waypoint, stopping at the first leg that does not arrive, a portal
 * among them. A waypoint off the mesh fails the walk rather than being
 * swapped for the nearest walkable point: by the Deadmines entrance that
 * point was an island no route reaches, and the walk ended `path_incomplete`
 * 0.4y from it in 2D, on the hill 22y above.
 */
import { describe, expect, test } from "bun:test";
import type { MoveResult } from "../sdk/src/index";
import { walkRoute } from "./smoke/lib/party";

type P = { x: number; y: number; z: number };

type Answer = { ok: boolean; status: string; [k: string]: unknown };

function fakeClient(answers: ((to: P) => Answer)[]) {
  let pos: P = { x: 0, y: 0, z: 0 };
  const calls: P[] = [];
  const client = {
    state: { self: { get position() { return { value: { ...pos, map: 0 } }; } } },
    async moveTo(to: P) {
      calls.push(to);
      const r = answers[calls.length - 1]!(to);
      if (r.ok && r.status === "arrived") pos = to;
      return r as unknown as MoveResult;
    },
  } as unknown as Parameters<typeof walkRoute>[0];
  return { client, calls };
}

const route: P[] = [
  { x: 10, y: 0, z: 0 },
  { x: 20, y: 0, z: 0 },
  { x: 30, y: 0, z: 0 },
];
const arrived = (): Answer => ({ ok: true, status: "arrived" });

describe("walkRoute", () => {
  test("walks every waypoint in order and returns the last arrival", async () => {
    const { client, calls } = fakeClient([arrived, arrived, arrived]);
    const lines: string[] = [];
    const r = await walkRoute(client, route, (s) => lines.push(s));
    expect(r.status).toBe("arrived");
    expect(calls).toEqual(route);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("leg 3/3");
  });

  test("a portal mid-route ends the walk transferred", async () => {
    const { client, calls } = fakeClient([arrived, () => ({ ok: true, status: "transferred", to: { map: 36, x: -16.4, y: -383.1, z: 61.8 } })]);
    const lines: string[] = [];
    const r = await walkRoute(client, route, (s) => lines.push(s));
    expect(r.ok && r.status === "transferred" && r.to.map).toBe(36);
    expect(calls).toHaveLength(2);
    expect(lines[1]).toContain("transferred to map 36");
  });

  test("a failed leg stops the walk and logs where the mesh ended, z included", async () => {
    const { client, calls } = fakeClient([arrived, () => ({ ok: false, status: "path_incomplete", reachedPos: { x: -11161.1, y: 1644.7, z: 51.8 } })]);
    const lines: string[] = [];
    const r = await walkRoute(client, route, (s) => lines.push(s));
    expect(r.status).toBe("path_incomplete");
    expect(calls).toHaveLength(2);
    expect(lines[1]).toContain("the mesh ends at (-11161.1, 1644.7, 51.8)");
  });

  test("a waypoint off the mesh fails the walk; the nearest point is not tried", async () => {
    const { client, calls } = fakeClient([() => ({ ok: false, status: "target_off_mesh", nearest: { x: 11, y: 0, z: -20 } })]);
    const r = await walkRoute(client, route, () => {});
    expect(r.status).toBe("target_off_mesh");
    expect(calls).toEqual([route[0]!]);
  });
});
