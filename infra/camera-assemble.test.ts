/**
 * What the run's video says (infra/camera/assemble.ts, camera/captions.ts): the
 * captions are the model's own words and the burned-in line is our own detail,
 * never game text, which must not reach a published video.
 */
import { describe, expect, test } from "bun:test";
import { planShots, subtitlesOf, timelineOf, VIDEO_FPS } from "./camera/assemble";
import { saidAt, saidOf } from "./camera/captions";
import { frameFile, type FrameLine } from "./camera/layout";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A 1 fps capture's kept frames: interval every 10 s, and a level-up burst 30 s before to 10 s after. */
function frameLines(levelAt: number): FrameLine[] {
  const event = { type: "level" as const, detail: "reached level 6" };
  const out: FrameLine[] = [];
  let seq = 0;
  let last = -Infinity;
  for (let t = T0; t <= T0 + 120_000; t += 1000) {
    const inBurst = t >= levelAt - 30_000 && t <= levelAt + 10_000;
    if (inBurst) out.push({ seq, t: iso(t), file: frameFile(seq++), kind: "event", event });
    else if (t - last >= 10_000) out.push({ seq, t: iso(t), file: frameFile(seq++), kind: "interval" });
    else continue;
    last = t;
  }
  return out;
}

function trajectory(): string {
  const rows = [
    { ts: T0 - 5_000, t: "meta", runId: "cam-run" },
    { ts: T0 + 1_000, t: "response", message: { role: "assistant", content: "## Plan\nHead to the **wolves** east of the abbey and clear them for the quest." } },
    { ts: T0 + 2_000, t: "tool_result", name: "run_snippet", text: "Quest text the game wrote: Bring me 8 wolf pelts, brave hero." },
    { ts: T0 + 50_000, t: "tool_call", name: "mcp__wrathbench__write_scratchpad", args: { content: "# Pad\n- Level 6 is next; then the bandits by the mill." } },
    { ts: T0 + 90_000, t: "response", message: { role: "assistant", content: [{ type: "text", text: "Level six. Turning in at the abbey now." }] } },
  ];
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("the video's words", () => {
  test("captions are only the model's own words: responses and pad lines, never a tool result", () => {
    const said = saidOf(trajectory());
    expect(said.map((s) => s.text)).toEqual(["Plan Head to the wolves east of the abbey and clear them for the quest.", "Level 6 is next; then the bandits by the mill.", "Level six. Turning in at the abbey now."]);
    expect(said.some((s) => /wolf pelts/.test(s.text))).toBe(false);
    expect(saidAt(said, T0)).toBe("");
    expect(saidAt(said, T0 + 60_000)).toBe("Level 6 is next; then the bandits by the mill.");
  });

  test("the burned-in line is our own detail while the event shows, never the model's words or game text", () => {
    const shots = planShots(frameLines(T0 + 60_000), { intervalMs: 10_000 });
    const seconds = shots.reduce((n, s) => n + s.ticks, 0) / VIDEO_FPS;
    const line = timelineOf(shots, 0, 0, saidOf(trajectory()), null);
    const ass = subtitlesOf(seconds, line.details, "DeepSeek V4");
    expect(ass).toContain("Hud,,0,0,0,,WrathBench · DeepSeek V4");
    expect(ass).toContain(",Ev,,0,0,0,,reached level 6");
    expect(ass).not.toContain("bandits");
    expect(ass).not.toContain("wolf pelts");
  });
});
