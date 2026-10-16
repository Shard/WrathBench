import { describe, expect, test } from "bun:test";
import { wakeWhenReady } from "./run-fleet";

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
