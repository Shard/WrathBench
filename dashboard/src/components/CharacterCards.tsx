/**
 * A character's own furniture: the totals card and the attempt strip.
 *
 * Both are drawn on two pages — the run page, where they say "the character
 * this attempt belongs to", and the character page, where they are the page.
 * They live here rather than on either so the two cannot drift into showing a
 * reader two different accounts of one character.
 */

import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import type { CharacterAttempt, CharacterView } from "../api/client";
import { fmtDuration, fmtTokens, num, shortRunId } from "../lib/format";
import { Coins, LevelXp } from "./CharacterFacts";
import { sourceHint, sourceLabel } from "../lib/runview";
import { Collapsible } from "./Collapsible";
import { CostCard, characterCostReading } from "./CostCard";
import { InfoHint } from "./InfoHint";
import { type RunStatus, statusOf, statusText, statusTitle, statusTone } from "../lib/runs";

/**
 * What a character has done, across every attempt of it.
 *
 * The figures are the server's (`character.totals`, aggregated at read time in
 * `viewer/character.ts`), never re-derived here, so this card and the
 * freeplay ladder cannot quote different numbers for one character.
 *
 * `runId` is the attempt the reader is ON, and is what makes this card two
 * cards. Given one, each figure names that attempt's own underneath, because a
 * reader on one attempt's page must never confuse its quests with the
 * character's. The character page passes none: there is no attempt to be
 * confused with, and a row reading "this attempt: —" would be a footnote about
 * nothing.
 *
 * Null is not zero anywhere below: "not recorded" is printed as such, since a
 * character whose older attempts predate a producer has not been observed doing
 * none of it.
 */
export function CharacterTotalsCard(props: { character: CharacterView; runId?: string }) {
  const t = (): CharacterView["totals"] => props.character.totals;
  const cost = (): CharacterView["totals"]["cost"] => t().cost;
  /*
   * This attempt's own row from the CHARACTER, not from the run row beside it.
   * The two are read at different moments on a live run — the character's
   * attempts come off the listing's memoised rows, the run row is re-read per
   * request — and the footnote under a total must be the same figure the strip
   * above it lists, or the page quietly disagrees with itself.
   */
  const here = (): CharacterAttempt | undefined =>
    props.runId === undefined ? undefined : props.character.runs.find((a) => a.runId === props.runId);
  /** "this attempt: …" — the run's own reading, beside the character's. Empty off a run page. */
  const mine = (v: string): string => (props.runId === undefined ? "" : `this attempt: ${v}`);
  return (
    <div class="cards">
      <div class="card">
        <div class="k">quests completed</div>
        <div class="v mono">{num(t().questsCompleted)}</div>
        <div class="sub">{mine(num(here()?.questsCompleted))}</div>
      </div>
      <div class="card">
        <div class="k">xp earned</div>
        <div class="v mono">{t().xpEarned === null ? "—" : t().xpEarned!.toLocaleString()}</div>
        <div class="sub">
          <LevelXp level={t().level} xp={null} compact /> <Coins copper={t().money} />
        </div>
      </div>
      <div class="card">
        <div class="k">playtime</div>
        <div class="v mono">{fmtDuration(t().playtimeMs)}</div>
        <div class="sub">{mine(fmtDuration(here()?.playtimeMs ?? null))}</div>
      </div>
      <div class="card">
        <div class="k">
          tokens in / out
          <InfoHint label="how the tokens were counted" text={sourceHint(t().tokens?.source)} />
        </div>
        <div class="v mono">
          {fmtTokens(t().tokens?.promptTokens ?? null)} / {fmtTokens(t().tokens?.completionTokens ?? null)}
        </div>
        <div class="sub">
          {sourceLabel(t().tokens?.source)} · {t().tokens?.turns ?? 0} turns · cache r/w{" "}
          {fmtTokens(t().tokens?.cacheReadTokens ?? null)} / {fmtTokens(t().tokens?.cacheWriteTokens ?? null)}
        </div>
      </div>
      {/*
        Two sums, never one, on one card (`CostCard`): `CostFigure` carries a
        basis and a price date, and a chain of attempts priced three different
        ways has no single one — so the dollars are added and the COVERAGE is
        printed beside them, which is what says how much of the character the
        figure actually accounts for.
      */}
      <CostCard reading={characterCostReading(cost())} />
      <div class="card">
        <div class="k">deaths · flights</div>
        <div class="v mono">
          {t().deaths === null || t().deaths === undefined ? "—" : t().deaths!.deaths} ·{" "}
          {t().taxi === null ? "—" : t().taxi!.flights}
        </div>
        <div class="sub">
          {t().achievements === null
            ? "achievements: not recorded"
            : `achievements: ${t().achievements!.earned} (${t().achievements!.points} pts)`}
        </div>
      </div>
      <div class="card">
        <div class="k">spells · talents · trades</div>
        <div class="v mono">
          {t().spells === null || t().spells === undefined ? "—" : t().spells!.learned} ·{" "}
          {t().talents === null || t().talents === undefined ? "—" : t().talents!.spends} ·{" "}
          {t().trades === null || t().trades === undefined ? "—" : t().trades!.trades}
        </div>
        <div class="sub">
          {num(t().toolCalls)} tool calls · {num(t().snippets)} snippets · {num(t().modelResponses)} replies
        </div>
      </div>
    </div>
  );
}

const TOTALS_OPEN_KEY = "wrathbench.runview.character";

/**
 * The character's totals on a run page: `CharacterTotalsCard` folded into a
 * pane under the milestones, closed until the reader opens it.
 *
 * It used to lead the sidebar, eight cards tall, so a reader scrolled past the
 * whole character before reaching anything about the run in front of them —
 * the operator's call was to fold it away. The summary keeps the one number a
 * closed pane should still answer: how many attempts there are. The character
 * page draws the cards bare; this pane is the run page's alone.
 */
export function CharacterTotalsPanel(props: { character: CharacterView; runId: string }) {
  return (
    <Collapsible
      title={<span title="this run's character, summed over every attempt">the character</span>}
      summary={`${props.character.attempts} attempt${props.character.attempts === 1 ? "" : "s"}`}
      storageKey={TOTALS_OPEN_KEY}
    >
      <CharacterTotalsCard character={props.character} runId={props.runId} />
    </Collapsible>
  );
}

/**
 * The whole character, attempt by attempt.
 *
 * This is the thing a durable freeplay run did not have: a reader landing on
 * one attempt could see the run id either side of it and nothing else, so
 * "the run" was only ever visible one attempt at a time. Each attempt is a
 * link, the one being read is marked, and each carries the three facts that
 * say what happened in it — what state it ended in, how far the character got,
 * and how long it played. The figures are the attempt's own; the totals are in
 * the sidebar, which is where the character's numbers live.
 */
export function AttemptStrip(props: { character: CharacterView; runId?: string }) {
  return (
    <div class="attempts">
      <div class="attempts-head dim" title="a durable freeplay character: one character, continued across attempts">
        freeplay character{" "}
        <A href={`/character/${encodeURIComponent(props.character.characterId)}`} title={props.character.characterId}>
          {shortRunId(props.character.characterId)}
        </A>{" "}
        <Show when={props.runId !== undefined} fallback={<>· {props.character.attempts} attempts</>}>
          · attempt {props.character.attempt} of {props.character.attempts}
        </Show>
        {/* The chain begins mid-history: the oldest attempt on screen still
            names a predecessor this viewer does not serve, so every total is a
            lower bound over what is shown. */}
        <Show when={props.character.truncated}>
          {" "}
          · <span title="the oldest attempt served still names a predecessor this viewer does not hold">
            earlier attempts not served
          </span>
        </Show>
      </div>
      <ol class="attempts-strip">
        <For each={props.character.runs}>
          {(a, i) => {
            const here = (): boolean => a.runId === props.runId;
            const status = (): RunStatus => statusOf(a);
            return (
              <li class={here() ? "attempt here" : "attempt"}>
                <A href={`/run/${encodeURIComponent(a.runId)}`} title={a.runId}>
                  <span class="n">#{i() + 1}</span>
                  <span class={statusTone(status())} title={statusTitle(status())}>
                    {statusText(a)}
                  </span>
                </A>
                <div class="dim">
                  {a.level === null ? "no level" : `L${a.level}`} · {fmtDuration(a.playtimeMs)}
                </div>
              </li>
            );
          }}
        </For>
      </ol>
    </div>
  );
}
