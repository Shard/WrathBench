/**
 * Probe campaigns: the commissioned middle lane, and how harness questions are
 * settled.
 *
 * A campaign is a matrix — cells (the start) × arms (the harness build and its
 * flags) × assignments (the models) — and this page answers two questions about
 * it: what is queued, running or done, and how its arms compare per model. The
 * index is one row per published version; `/campaigns/:id/:version` is one
 * campaign, with its shape, its arms, the cells × (assignment × arm) grid and
 * the arm comparison.
 *
 * Everything on it comes from `/api/campaigns` alone. State, progress, live
 * markers, run ids and cost are decided server-side by the same counting the
 * scheduler uses, so nothing here joins another feed to find out what is live,
 * and nothing reads the store row's account, which the public projection omits.
 * Nothing is ranked (lib/campaigns.ts says why).
 */

import { A, useParams, useSearchParams } from "@solidjs/router";
import { For, Show } from "solid-js";
import { api, type CampaignsResponse, type CampaignView, type Square } from "../api/client";
import { InfoHint } from "../components/InfoHint";
import {
  COST_TITLE,
  armRowText,
  armTitle,
  argvText,
  assignmentLabel,
  assignmentTitle,
  assignmentsText,
  assignmentsTitle,
  campaignHref,
  clockText,
  columnGroups,
  columnLabel,
  endGoal,
  findCampaign,
  gridRows,
  imageTitle,
  medianTitle,
  progressText,
  progressTitle,
  selectedSquare,
  refusalsFor,
  shortImage,
  sourceText,
  squareClass,
  squareHref,
  squareText,
  squareTitle,
  stateClass,
  stateTitle,
  truncate,
  wikiText,
} from "../lib/campaigns";
import { displayError } from "../lib/errors";
import { fmtUsd, fmtWhen, shortRunId, stamp } from "../lib/format";
import { partyHref, partyReplayHref } from "../lib/party";
import { poll } from "../lib/poll";

/** What a campaign is, and why nothing here reaches a chart. */
const CAMPAIGNS_NOTE =
  "Commissioned sweeps of a published campaign definition: cells (the start) × arms (the harness build and flags) × assignments (the models). Every run is an unscored probe episode (see the about page), so nothing here reaches a chart or a target, and nothing is ranked.";

/** Progress and live markers move when a probe starts or ends. */
const POLL_MS = 30_000;

/** How much of a question the index shows; the rest is in the hover. */
const QUESTION_CHARS = 72;

export default function Campaigns() {
  const params = useParams<{ id?: string; version?: string }>();
  const feed = poll(() => api.campaigns(), POLL_MS);
  const body = (): CampaignsResponse | undefined => feed.latest;

  return (
    <div class="page">
      <Show when={feed.error !== undefined}>
        <div class="banner bad">{displayError(feed.error)}</div>
      </Show>
      <Show when={params.id !== undefined && params.version !== undefined} fallback={<Index body={body()} />}>
        <Campaign body={body()} id={params.id!} version={params.version!} />
      </Show>
    </div>
  );
}

/** The index: one row per published campaign version, then the store rows the viewer refused. */
function Index(props: { body: CampaignsResponse | undefined }) {
  // `refused` is read defensively: a projection that leaves it out is a page
  // with nothing refused, not a crash.
  const refused = (): CampaignsResponse["refused"] => props.body?.refused ?? [];
  return (
    <>
      <h1>
        campaigns
        <InfoHint label="about this page" text={CAMPAIGNS_NOTE} />
      </h1>
      <Show when={props.body} fallback={<p class="dim">loading…</p>}>
        {(b) => (
          <>
            <div class="scroller">
              <table>
                <thead>
                  <tr>
                    <th>campaign</th>
                    <th>state</th>
                    <th>question</th>
                    <th class="right">arms</th>
                    <th>assignments</th>
                    <th class="right">progress</th>
                    <th class="right">cost</th>
                    <th>newest</th>
                  </tr>
                </thead>
                <tbody>
                  <Show when={b().campaigns.length === 0}>
                    <tr>
                      <td colSpan={8} class="dim">
                        no published campaigns
                      </td>
                    </tr>
                  </Show>
                  <For each={b().campaigns}>{(c) => <IndexRow c={c} />}</For>
                </tbody>
              </table>
            </div>

            <Refused rows={refused()} />
          </>
        )}
      </Show>
    </>
  );
}

/**
 * What the viewer read and did not use, with why: a store row, a published
 * definition, or an (assignment, arm) pair that cannot launch as configured.
 * Nothing when there is nothing.
 */
function Refused(props: { rows: CampaignsResponse["refused"] }) {
  return (
    <Show when={props.rows.length > 0}>
      <h2 class="section">refused</h2>
      <div class="scroller">
        <table>
          <thead>
            <tr>
              <th>key</th>
              <th>reason</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(r) => (
                <tr>
                  <td>{r.key}</td>
                  <td class="err">{r.reason}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}

function IndexRow(props: { c: CampaignView }) {
  const c = (): CampaignView => props.c;
  return (
    <tr>
      <td>
        <A href={campaignHref(c())}>{c().key}</A>
      </td>
      <td>
        <span class={stateClass(c().state)} title={stateTitle(c().state)}>
          {c().state}
        </span>
      </td>
      <td class="dim" title={c().question}>
        {truncate(c().question, QUESTION_CHARS)}
      </td>
      <td class="right mono" title={c().arms.map((a) => a.id).join(", ")}>
        {c().arms.length}
      </td>
      <td class="dim" title={assignmentsTitle(c())}>
        {assignmentsText(c())}
      </td>
      <td class="right mono" title={progressTitle(c().progress)}>
        <ProgressFigure c={c()} />
      </td>
      <td class="right mono dim" title={COST_TITLE}>
        {fmtUsd(c().costUsd)}
      </td>
      <td class="dim">
        <NewestLink c={c()} />
      </td>
    </tr>
  );
}

/** `12/40`, then the live marker and count when a run is in flight. */
function ProgressFigure(props: { c: CampaignView }) {
  return (
    <>
      {progressText(props.c.progress)}
      <Show when={props.c.progress.live > 0}>
        {" · "}
        <span class="dot live" />
        {props.c.progress.live} live
      </Show>
    </>
  );
}

function NewestLink(props: { c: CampaignView }) {
  return (
    <Show when={props.c.newestRunId} fallback="—">
      {(id) => (
        <A href={`/run/${encodeURIComponent(id())}`} title={id()}>
          {fmtWhen(props.c.newestAt)}
        </A>
      )}
    </Show>
  );
}

/** One campaign version's page, picked out of the same response the index reads. */
function Campaign(props: { body: CampaignsResponse | undefined; id: string; version: string }) {
  const found = (): CampaignView | undefined => (props.body === undefined ? undefined : findCampaign(props.body, props.id, props.version));
  return (
    <Show
      when={found()}
      fallback={
        <>
          <h1>
            {props.id}@{props.version}
          </h1>
          <p class="dim">{props.body === undefined ? "loading…" : "not published"}</p>
        </>
      }
    >
      {(c) => <CampaignBody c={c()} refused={refusalsFor(props.body!, c())} />}
    </Show>
  );
}

function CampaignBody(props: { c: CampaignView; refused: CampaignsResponse["refused"] }) {
  const c = (): CampaignView => props.c;
  const stop = (): number | null => c().shape.stopAtLevel;
  const goal = (): string | null => endGoal(c().shape);
  const [search] = useSearchParams<{ cell?: string; column?: string }>();
  const selected = () => selectedSquare(c(), search.cell, search.column);

  return (
    <>
      <h1>
        {c().key}{" "}
        <span class={stateClass(c().state)} title={stateTitle(c().state)}>
          {c().state}
        </span>
      </h1>

      <dl class="tuple">
        <dt>question</dt>
        <dd>{c().question}</dd>
        <Show when={c().note}>
          {(note) => (
            <>
              <dt>note</dt>
              <dd>{note()}</dd>
            </>
          )}
        </Show>
        <dt>progress</dt>
        <dd class="mono" title={progressTitle(c().progress)}>
          <ProgressFigure c={c()} />
        </dd>
        <dt>cost</dt>
        <dd class="mono" title={COST_TITLE}>
          {fmtUsd(c().costUsd)}
        </dd>
        <dt>newest</dt>
        <dd>
          <NewestLink c={c()} />
        </dd>
        <dt>objective</dt>
        <dd>{c().shape.objective ?? "—"}</dd>
        <dt>ends</dt>
        <dd class="mono">{goal() ?? "—"}</dd>
        <dt>clock</dt>
        <dd class="mono">{clockText(c().shape)}</dd>
        <dt>tool calls</dt>
        <dd class="mono">{c().shape.maxToolCalls}</dd>
        <dt>wiki</dt>
        <dd>{wikiText(c().shape)}</dd>
        <dt>resume</dt>
        <dd>{c().shape.resume ? "yes" : "no"}</dd>
        <dt>attempts per cell</dt>
        <dd class="mono">{c().shape.maxAttemptsPerCell ?? "—"}</dd>
        <dt>definition</dt>
        <dd class="mono" title={c().hash}>
          {c().hash.slice(0, 12)}
          <Show when={c().source}>
            {(s) => (
              <span title={s().commit}>
                {" · "}
                {sourceText(s())}
              </span>
            )}
          </Show>
          <Show when={c().publishedAt !== null}>
            {" · "}
            <span title={stamp(c().publishedAt)}>published {fmtWhen(c().publishedAt)}</span>
          </Show>
        </dd>
      </dl>

      <h2 class="section">arms</h2>
      <div class="scroller">
        <table>
          <thead>
            <tr>
              <th>arm</th>
              <th>image</th>
              <th>command</th>
              <th>args</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            <For each={c().arms}>
              {(a) => (
                <tr>
                  <td>{a.id}</td>
                  <td class={a.image === null ? "dim" : ""} title={imageTitle(a.image)}>
                    {shortImage(a.image)}
                  </td>
                  <td class="dim">{argvText(a.command)}</td>
                  <td>{argvText(a.args)}</td>
                  <td class="dim">{a.note ?? "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <h2 class="section">grid</h2>
      <Show
        when={c().columns.length > 0}
        fallback={<p class="dim">{c().config === null ? "no store row" : "no assignments"}</p>}
      >
        <Grid c={c()} />
        <Show when={selected()}>
          {(s) => (
            <div class="detail">
              <p>
                {s().cell} · {columnLabel(s().column)} · {s().column.arm} ·{" "}
                <A href={campaignHref(c())}>close</A>
              </p>
              {/* A party square's attempts are parties: each one's page, then its replay. */}
              <Show
                when={s().square.parties}
                fallback={
                  <For each={s().square.runIds}>
                    {(id, i) => (
                      <>
                        <Show when={i() > 0}>{", "}</Show>
                        <A href={`/run/${encodeURIComponent(id)}`} title={id}>
                          {shortRunId(id)}
                        </A>
                      </>
                    )}
                  </For>
                }
              >
                {(parties) => (
                  <For each={parties()}>
                    {(id) => (
                      <p>
                        <A href={partyHref(id)} title={id}>
                          party {shortRunId(id)}
                        </A>
                        {" · "}
                        <A href={partyReplayHref(id)}>replay</A>
                      </p>
                    )}
                  </For>
                )}
              </Show>
            </div>
          )}
        </Show>
      </Show>

      <h2 class="section">arm comparison</h2>
      <Show when={c().comparison.length > 0} fallback={<p class="dim">{c().config === null ? "no store row" : "no assignments"}</p>}>
        <div class="scroller">
          <table>
            <thead>
              <tr>
                <th>assignment</th>
                <th>arm</th>
                <th class="right">runs</th>
                <th class="right" title={goal() === null ? "this campaign sets no end" : `runs that reached ${goal()}`}>
                  reached
                </th>
                <th class="right" title={medianTitle("minutes of play", stop())}>
                  min
                </th>
                <th class="right" title={medianTitle("turns", stop())}>
                  turns
                </th>
                <th class="right" title={medianTitle("cost", stop())}>
                  cost
                </th>
                <th class="right" title={medianTitle("prompt tokens", stop())}>
                  prompt
                </th>
                <th>terminations</th>
                <th>builds</th>
              </tr>
            </thead>
            <tbody>
              <For each={c().comparison}>
                {(g) => (
                  <For each={g.arms}>
                    {(a, i) => {
                      const t = armRowText(a);
                      const head = assignmentLabel(c(), g.ref);
                      return (
                        <tr>
                          <Show when={i() === 0}>
                            <td rowSpan={g.arms.length} title={head.title}>
                              {head.label}
                            </td>
                          </Show>
                          <td title={armTitle(c().arms.find((x) => x.id === a.arm))}>{a.arm}</td>
                          <td class="right mono">{t.runs}</td>
                          <td class="right mono">{t.reached}</td>
                          <td class="right mono">{t.minutes}</td>
                          <td class="right mono">{t.turns}</td>
                          <td class="right mono" title={t.costTitle}>
                            {t.cost}
                          </td>
                          <td class="right mono">{t.promptTokens}</td>
                          <td class="dim">{t.terminations}</td>
                          <td class="dim" title={a.builds.join("\n")}>
                            {t.builds}
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Refused rows={props.refused} />
    </>
  );
}

/**
 * The cells × (assignment × arm) grid. Two header rows: each assignment over
 * its arms, then the arm ids — the second row is dropped for a single-arm
 * sweep, where it would repeat one id across every column.
 */
function Grid(props: { c: CampaignView }) {
  const c = (): CampaignView => props.c;
  const goal = (): string | null => endGoal(c().shape);
  const multiArm = (): boolean => c().arms.length > 1;
  return (
    <div class="scroller">
      <table>
        <thead>
          <tr>
            <th rowSpan={multiArm() ? 2 : 1}>cell</th>
            <th rowSpan={multiArm() ? 2 : 1}>start</th>
            <For each={columnGroups(c().columns)}>
              {(g) => (
                <th class="right" colSpan={g.span} title={assignmentTitle(g.first)}>
                  {columnLabel(g.first)}
                </th>
              )}
            </For>
          </tr>
          <Show when={multiArm()}>
            <tr>
              <For each={c().columns}>
                {(col) => (
                  <th class="right" title={armTitle(c().arms.find((a) => a.id === col.arm))}>
                    {col.arm}
                  </th>
                )}
              </For>
            </tr>
          </Show>
        </thead>
        <tbody>
          <For each={gridRows(c())}>
            {(row) => (
              <tr>
                <td title={row.cell.note ?? ""}>
                  {row.cell.id}
                  <Show when={row.cell.note !== undefined}>
                    <span class="dim">*</span>
                  </Show>
                </td>
                <td class="dim">{row.start}</td>
                <For each={row.squares}>
                  {(sq) => <SquareCell c={c()} cell={row.cell.id} sq={sq} goal={goal()} />}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/**
 * One square: its live marker, then its figure, both inside the link to its
 * runs — so a square whose only run is live is still a way into that run.
 */
function SquareCell(props: { c: CampaignView; cell: string; sq: Square | null; goal: string | null }) {
  const href = (): string | null => squareHref(props.c, props.cell, props.sq);
  const figure = () => (
    <>
      <Show when={(props.sq?.live ?? 0) > 0}>
        <span class="dot live" />
      </Show>
      {squareText(props.sq, props.goal)}
    </>
  );
  return (
    <td class={squareClass(props.sq, props.goal)} title={squareTitle(props.sq, props.goal)}>
      <Show when={href()} fallback={figure()}>
        {(to) => <A href={to()}>{figure()}</A>}
      </Show>
    </td>
  );
}
