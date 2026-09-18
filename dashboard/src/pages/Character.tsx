/**
 * One character, across every session it has played.
 *
 * The run page is session-first and stays that way: a reader who opened an
 * attempt wants that attempt's feed, its live header, its own figures. But the
 * thing the benchmark actually follows is longer than a session — an instance
 * of a model at an effort, and the character it has been driving for a
 * fortnight — and until item 128 that thing had no page, only a card at the
 * bottom of whichever attempt you happened to open, addressed by the head run's
 * id. This is that page.
 *
 * Universal, not freeplay-only (operator, 2026-09-16): a scored run is a
 * character of one attempt, so this page renders for any run id. The strip
 * reads "1 attempt", the curve is one session, and nothing branches.
 *
 * The id in the URL is any attempt's run id — the server resolves the chain
 * from any member and answers with the canonical `characterId`, which is what
 * the crumb shows.
 */

import { A, useParams } from "@solidjs/router";
import { For, Show, createMemo } from "solid-js";
import {
  api,
  type CharacterResponse,
  type CharacterView,
} from "../api/client";
import { CharacterTotalsCard } from "../components/CharacterCards";
import { CharacterPlot } from "../components/CharacterChart";
import { ModelIcon } from "../components/ModelIcon";
import { UnitFrame } from "../components/UnitFrame";
import { XpChart } from "../components/XpChart";
import { characterSessionSeries } from "../lib/character";
import { displayError } from "../lib/errors";
import { fmtAge, fmtDuration, fmtMoney, modelDisplay, num, shortHarness, shortRunId, stamp } from "../lib/format";
import { characterSeriesLabel, stitchCharacter, type CharacterSeries } from "../lib/ladder";
import { LevelXp } from "../components/CharacterFacts";
import { poll } from "../lib/poll";
import { statusOf, statusText } from "../lib/runs";
import type { PowerType } from "../lib/unitframe";

/**
 * How often a character with a live attempt is re-fetched.
 *
 * The run page's own cadence (`DETAIL_POLL_MS`), for the reason it gives:
 * matched to the fleet listing so two pages open on one session do not show
 * two different playtimes. A character with nothing live polls anyway and
 * settles on an unchanged body — `poll` compares content and leaves the graph
 * alone — which is what keeps an attempt that STARTS while the page is open
 * from needing a reload.
 */
const POLL_MS = 10_000;

export default function Character() {
  const params = useParams<{ id: string }>();
  const feed = poll<CharacterResponse>(() => api.character(params.id), POLL_MS);

  const view = (): CharacterView | undefined => feed.latest?.character;
  /** The attempt a reader would call "now": the last one in the chain. */
  const latest = () => view()?.runs[(view()?.runs.length ?? 0) - 1];
  const isLive = (): boolean => {
    const l = latest();
    return l !== undefined && statusOf(l) === "live";
  };

  /**
   * The whole character as one series for `CharacterPlot`: level against
   * cumulative ACTIVE playtime, stitched across attempts.
   *
   * The same call the run page makes and the same one the ladder's field is
   * built from (`stitchCharacter`), so a character's line is the same line on
   * all three. A character that cannot be laid out comes back with the reason
   * instead of a wrong drawing.
   */
  const plot = createMemo((): { series: CharacterSeries[]; omitted: { characterId: string; label: string; why: string }[] } | null => {
    const st = view();
    const last = latest();
    if (st === undefined || last === undefined) return null;
    const model = st.model ?? "(unnamed)";
    // The line is named for the model, not the character (operator, 2026-09-18);
    // the name rides along for the hover.
    const label = characterSeriesLabel(model, st.effort);
    const { points, endX, broke } = stitchCharacter(st.runs);
    const why = broke ?? (points.length === 0 ? "no level mark carries an active-time reading" : null);
    if (why !== null) return { series: [], omitted: [{ characterId: st.characterId, label, why }] };
    const end = points[points.length - 1]!;
    return {
      series: [
        {
          characterId: st.characterId,
          label,
          character: st.name,
          model,
          effort: st.effort,
          status: statusOf(last),
          attempts: st.attempts,
          latestRunId: last.runId,
          points,
          endX: Math.max(endX, end.x),
          endLevel: end.level,
          truncated: st.truncated,
        },
      ],
      omitted: [],
    };
  });

  /**
   * The state samples on one cumulative-session-time axis, with a seam per
   * attempt after the first (`lib/character.ts`). This is the finer of the two
   * curves — every sample rather than every ding — and the coarser one above
   * is the comparable one, which is why the captions say which is which.
   */
  const series = createMemo(() => {
    const d = feed.latest;
    return d === undefined ? null : characterSessionSeries(d.states);
  });

  const seams = createMemo(() =>
    (series()?.seams ?? []).map((s) => ({ at: s.at, label: `attempt ${s.attempt} begins (${shortRunId(s.runId)})` })),
  );

  /** The newest sample the character has: its standing right now. */
  const standing = () => {
    const d = feed.latest;
    return d === undefined ? undefined : d.states[d.states.length - 1];
  };

  return (
    <div class="page">
      <Show when={feed.error}>
        <div class="banner bad">{displayError(feed.error, { retries: true })}</div>
      </Show>
      <Show when={view()} fallback={<p class="dim loading-page">loading…</p>}>
        {(st) => (
          <>
            <h2 class="section">
              <A href="/ladder">ladder</A> / <span title={st().characterId}>{shortRunId(st().characterId)}</span>
            </h2>

            {/* The header: who this character is, and whether it is playing
                right now. The model and the harness come off the newest
                attempt — a character can outlive a harness patch, and what it
                is on NOW is the honest heading for a page about the present. */}
            <div class="characterhead">
              <h1>{st().name ?? shortRunId(st().characterId)}</h1>
              <div class="dim">
                <ModelIcon model={st().model ?? ""} />
                <span title={st().model ?? ""}>{modelDisplay(st().model ?? "(unnamed)")}</span>
                <Show when={st().effort}>{(e) => <> · {e()}</>}</Show>
                <Show when={st().driver}>{(dr) => <> · {dr()}</>}</Show>
                {/* The harness the NEWEST attempt ran under: a character can
                    outlive a patch, and the run page lists each attempt's own. */}
                <Show when={st().harnessVersion}>
                  {(h) => (
                    <>
                      {" · "}
                      <span class="mono" title={h()}>
                        {shortHarness(h())}
                      </span>
                    </>
                  )}
                </Show>
                {" · "}
                <span class={isLive() ? "ok" : statusOf(latest()!) === "paused" ? "warn" : "dim"}>
                  {statusText(latest()!)}
                </span>
                {" · "}
                {st().attempts} {st().attempts === 1 ? "attempt" : "attempts"}
              </div>
            </div>

            {/* The live session, when one runs. The run page owns the feed and
                the turn-by-turn detail; what belongs here is only "is it
                playing, and where has it got to" — with a link to the session
                for everything else. */}
            <Show when={isLive() ? latest() : undefined}>
              {(l) => (
                <div class="card live-attempt">
                  <div class="k">
                    playing now ·{" "}
                    <A href={`/run/${encodeURIComponent(l().runId)}`} title={l().runId}>
                      {shortRunId(l().runId)}
                    </A>
                  </div>
                  <UnitFrame
                    level={standing()?.level ?? l().level}
                    xp={standing()?.xp}
                    nextLevelXp={standing()?.nextLevelXp}
                    health={standing()?.health}
                    maxHealth={standing()?.maxHealth}
                    power={standing()?.power}
                    maxPower={standing()?.maxPower}
                    powerType={(standing()?.powerType ?? undefined) as PowerType | undefined}
                  />
                  <div class="sub dim">
                    this session: {fmtDuration(l().playtimeMs)} played · {num(l().questsCompleted)} quests
                    <Show when={standing()}>
                      {/* `fmtAge` takes an age, not a timestamp, and says "ago"
                          itself. The clock is this browser's, which is the same
                          reading the run page's own header takes. */}
                      {(s) => <> · last sample {fmtAge(Date.now() - s().ts)} ({stamp(s().ts)})</>}
                    </Show>
                  </div>
                </div>
              )}
            </Show>

            {/* The totals: the server's, never re-derived here, and with no
                attempt to be confused with — which is why no `runId` is passed
                and no "this attempt" footnote is printed. */}
            <h2 class="section">the character, across {st().attempts} {st().attempts === 1 ? "attempt" : "attempts"}</h2>
            <CharacterTotalsCard character={st()} />

            {/* The climb, coarse then fine. */}
            <Show when={plot()}>
              {(p) => <CharacterPlot series={p().series} omitted={p().omitted} single />}
            </Show>

            <Show when={series()}>
              {(s) => (
                <>
                  <XpChart
                    states={s().states}
                    startedAt={0}
                    endedAt={s().totalMs}
                    episodeMs={null}
                    now={s().totalMs}
                    seams={seams()}
                  />
                  <p class="dim ladderchart-caption">
                    cumulative xp against <strong>session time</strong>, every state sample, laid end to end
                    across {st().attempts} {st().attempts === 1 ? "session" : "sessions"} with the
                    boundaries dashed. The days a character spends paused between sessions are closed
                    rather than drawn — a week of flat line is the pause, not the character. This is not
                    the axis above: that one is pause-corrected <em>active</em> playtime, the figure a run
                    is compared on, and this one is sample-to-sample elapsed time inside a session.
                    <Show when={s().states.length < 2}>
                      {" "}
                      Nothing to draw yet: this character has fewer than two published samples.
                    </Show>
                  </p>
                </>
              )}
            </Show>

            {/*
              Every attempt, each a link to its own page. The run page's compact
              strip is deliberately NOT drawn here: there it answers "where am I
              in the chain", which is a question a reader of this page does not
              have, and it would say in icons what the table below says in full.
            */}
            <h2 class="section">the attempts</h2>
            <Show when={st().truncated}>
              <p class="dim" title="the oldest attempt served still names a predecessor this viewer does not hold">
                This character begins mid-history: earlier attempts are not served, so every total above
                is a lower bound over what is listed here.
              </p>
            </Show>
            <div class="scroller">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>run</th>
                    <th>status</th>
                    <th>started</th>
                    <th class="right">level</th>
                    <th class="right">quests</th>
                    <th class="right">playtime</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={st().runs}>
                    {(a, i) => (
                      <tr>
                        <td class="mono dim">{i() + 1}</td>
                        <td class="mono">
                          <A href={`/run/${encodeURIComponent(a.runId)}`} title={a.runId}>
                            {shortRunId(a.runId)}
                          </A>
                        </td>
                        <td>
                          <span class={statusOf(a) === "live" ? "ok" : statusOf(a) === "paused" ? "warn" : "dim"}>
                            {statusText(a)}
                          </span>
                        </td>
                        <td class="dim">{a.startedAt === null ? "—" : stamp(a.startedAt)}</td>
                        <td class="right mono">
                          <LevelXp level={a.level} xp={null} compact />
                        </td>
                        <td class="right mono dim">{num(a.questsCompleted)}</td>
                        <td class="right mono dim">{fmtDuration(a.playtimeMs)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <p class="dim">
              gold held: {fmtMoney(st().totals.money)}. The figures above are the whole character's;
              each attempt's own are on its run page.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}
