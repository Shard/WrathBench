import { describe, expect, test } from "bun:test";
import { wakeWhenReady } from "./run-fleet";
import { healthReady } from "./run-fleet-plan";

/** Resolves once `cond` holds, polling every few milliseconds; fails the test after 2s. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(2);
  }
}

describe("wakeWhenReady: the gate's readiness poll", () => {
  test("wakes once, on the first probe that answers ready, and stops probing", async () => {
    const answers = [false, false, true, true];
    let probes = 0;
    let wakes = 0;
    wakeWhenReady(async () => answers[probes++] ?? true, 5, () => wakes++);
    await until(() => wakes === 1);
    await Bun.sleep(30);
    expect(probes).toBe(3);
    expect(wakes).toBe(1);
  });

  test("does not probe before the first interval has passed", async () => {
    let probes = 0;
    const cancel = wakeWhenReady(async () => (probes++, false), 50, () => {});
    await Bun.sleep(10);
    expect(probes).toBe(0);
    cancel();
  });

  test("a probe that throws is not ready, and polling goes on", async () => {
    let probes = 0;
    let wakes = 0;
    wakeWhenReady(
      async () => {
        probes++;
        if (probes === 1) throw new Error("connection refused");
        return true;
      },
      5,
      () => wakes++,
    );
    await until(() => wakes === 1);
    expect(probes).toBe(2);
  });

  test("cancel stops the polling and never wakes, even with a probe in flight", async () => {
    let probes = 0;
    let wakes = 0;
    let release: (v: boolean) => void = () => {};
    const cancel = wakeWhenReady(
      () => {
        probes++;
        return new Promise<boolean>((r) => (release = r));
      },
      5,
      () => wakes++,
    );
    await until(() => probes === 1);
    cancel();
    release(true);
    await Bun.sleep(30);
    expect(probes).toBe(1);
    expect(wakes).toBe(0);
  });

  test("one probe at a time: a slow probe holds the next one back", async () => {
    let inFlight = 0;
    let most = 0;
    let probes = 0;
    const cancel = wakeWhenReady(
      async () => {
        probes++;
        inFlight++;
        most = Math.max(most, inFlight);
        await Bun.sleep(20);
        inFlight--;
        return false;
      },
      2,
      () => {},
    );
    await until(() => probes >= 3);
    cancel();
    expect(most).toBe(1);
  });
});

describe("healthReady: what the gate counts as a server to smoke", () => {
  const loaded = {
    ok: true,
    module: "mod-wrathbench",
    worldStopped: false,
    worldLoaded: true,
    sessions: 0,
    droppedPackets: 0,
    droppedPacketsLive: 0,
    build: "harness-0.5-1070-gabcdef0",
    startedAtMs: 1_790_000_000_000,
    uptimeMs: 200_000,
  };

  test("a 200 from a world that loaded whole is ready", () => {
    expect(healthReady(200, loaded)).toBe(true);
  });

  test("a module that predates worldLoaded is judged on ok and worldStopped, as before", () => {
    const { worldLoaded: _, ...older } = loaded;
    expect(healthReady(200, older)).toBe(true);
  });

  test("503 world_not_loaded (a load that lost rows to a database restart) is not ready", () => {
    const short = { ...loaded, ok: false, error: "world_not_loaded", worldLoaded: false };
    expect(healthReady(503, short)).toBe(false);
  });

  test("worldLoaded: false is not ready even under a 200", () => {
    expect(healthReady(200, { ...loaded, worldLoaded: false })).toBe(false);
  });

  test("a stopping world, a refusal and a body that is not an object are not ready", () => {
    expect(healthReady(200, { ...loaded, worldStopped: true })).toBe(false);
    expect(healthReady(401, { ok: false, error: "unauthorized" })).toBe(false);
    expect(healthReady(200, null)).toBe(false);
    expect(healthReady(200, "ok")).toBe(false);
  });
});
