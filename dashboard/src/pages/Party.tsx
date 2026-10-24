/**
 * One party attempt: the five member runs a Deadmines party is launched,
 * stopped and counted as, on one page (docs/proposals/GROUP-PLAY.md).
 *
 * The party is assembled in the browser from what both builds serve
 * (`lib/party.ts`), so this page is the same over the private viewer and the
 * public bucket. It is a heading, the members as a table, and one timeline
 * merged across them; each member's own page is a link away, and the group
 * replay is the map's (`/map?party=<id>`).
 */

import { A, useParams } from "@solidjs/router";
import { For, Show, createMemo, createSignal } from "solid-js";
import { api } from "../api/client";
import { HarnessTag } from "../components/HarnessTag";
import { InfoHint } from "../components/InfoHint";
import { LevelXp } from "../components/CharacterFacts";
import { ModelIcon } from "../components/ModelIcon";
import { displayError } from "../lib/errors";
import { fmtDuration, fmtElapsed, modelDisplay, num, shortHarness, shortRunId, stamp } from "../lib/format";
import { mapName } from "../lib/mapview";
import {
  memberClass,
  memberOf,
  loadParty,
  partyIsLive,
  partyReplayHref,
  whereIds,
  whereLabel,
  type PartyEvent,
  type PartyEventKind,
  type PartyMember,
  type PartyView,
} from "../lib/party";
import { poll, whileLive } from "../lib/poll";
import { statusText, statusTitle, statusTone } from "../lib/runs";
import { campaignHref } from "../lib/campaigns";

/** A live party's members level, die and talk. */
const LIVE_POLL_MS = 15_000;

/**
 * An ended or paused party's page is static, and each poll is the whole
 * unfiltered listing plus every member's detail, so it is only re-read now and
 * then: often enough that a resumed party is picked up without a reload.
 */
const IDLE_POLL_MS = 300_000;

/** The timeline's filter, one toggle per group of kinds. */
const KIND_GROUPS: readonly { label: string; kinds: readonly PartyEventKind[] }[] = [
  { label: "deaths", kinds: ["death"] },
  { label: "maps", kinds: ["enter", "leave"] },
  { label: "kills", kinds: ["kill"] },
  { label: "levels", kinds: ["level"] },
  { label: "chat", kinds: ["chat"] },
  { label: "party", kinds: ["left", "end"] },
];

export default function Party() {
  const params = useParams<{ id: string }>();
  const feed = poll<PartyView | null>(() => loadParty(api, params.id), whileLive(partyIsLive, LIVE_POLL_MS, IDLE_POLL_MS));
  const view = (): PartyView | null | undefined => feed.latest;
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (label: string): void => {
    const next = new Set(hidden());
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setHidden(next);
  };
  const shownKinds = createMemo(
    () => new Set(KIND_GROUPS.filter((g) => !hidden().has(g.label)).flatMap((g) => g.kinds)),
  );

  return (
    <div class="page">
      <Show when={feed.error}>
        <div class="banner bad">{displayError(feed.error, { retries: true })}</div>
      </Show>
      <Show when={view() !== undefined} fallback={<p class="dim loading-page">loading…</p>}>
        <Show when={view()} fallback={<p class="dim">no such party: {params.id}</p>}>
          {(v) => {
            const events = createMemo(() => v().events.filter((e) => shownKinds().has(e.kind)));
            const counts = createMemo(() => {
              const out = new Map<string, number>();
              for (const g of KIND_GROUPS) out.set(g.label, v().events.filter((e) => g.kinds.includes(e.kind)).length);
              return out;
            });
            const deaths = (): number | null => {
              const all = v().members.map((m) => m.deaths);
              return all.every((d) => d === null) ? null : all.reduce<number>((s, d) => s + (d ?? 0), 0);
            };
            return (
              <>
                <div class="dim">
                  <A href="/runs">runs</A> / <span title={v().id}>{shortRunId(v().id)}</span>
                </div>
                <div class="characterhead">
                  <h1>party · {shortRunId(v().id)}</h1>
                  <div class="dim">
                    <ModelIcon model={v().model ?? ""} />
                    <span title={v().model ?? ""}>{modelDisplay(v().model ?? "(unnamed)")}</span>
                    {" · "}
                    <HarnessTag harness={v().harness} />
                    <Show when={v().harnessVersion}>
                      {(h) => (
                        <>
                          {" "}
                          <span class="mono" title={h()}>
                            {shortHarness(h())}
                          </span>
                        </>
                      )}
                    </Show>
                    {" · "}
                    <span class={statusTone(v().status)} title={statusTitle(v().status)}>
                      {v().status}
                    </span>
                    {" · "}
                    {v().members.length} of {v().size} members
                  </div>
                </div>

                <div class="side-controls">
                  <A class="btn" href={partyReplayHref(v().id)}>
                    replay on map
                  </A>
                </div>

                <dl class="tuple">
                  <dt>campaign</dt>
                  <dd>
                    <Show when={v().campaign} fallback="—">
                      {(c) => (
                        <Show when={v().campaignVersion} fallback={c()}>
                          {(ver) => <A href={campaignHref({ id: c(), version: ver() })}>{c()} v{ver()}</A>}
                        </Show>
                      )}
                    </Show>
                    <Show when={v().cell}>{(c) => <span class="dim"> · {c()}</span>}</Show>
                    <Show when={v().arm}>{(a) => <span class="dim"> · {a()}</span>}</Show>
                  </dd>
                  <dt>started</dt>
                  <dd>{stamp(v().startedAt)}</dd>
                  <dt>ended</dt>
                  <dd>
                    {v().endedAt === null ? "—" : stamp(v().endedAt)}
                    <Show when={v().startedAt !== null && v().endedAt !== null}>
                      <span class="dim"> · {fmtDuration(v().endedAt! - v().startedAt!)}</span>
                    </Show>
                  </dd>
                  <dt>verdict</dt>
                  <dd>
                    <Show when={v().endedBy} fallback={<span class={statusTone(v().status)}>{v().status}</span>}>
                      {(e) => (
                        <span class={v().reached ? "ok" : ""} title={e().detail ?? ""}>
                          <Show when={v().reached}>reached · </Show>
                          {e().reason}
                          <Show when={e().member}>
                            {(id) => <span class="dim"> · {memberOf(v(), id())?.character || id()}</span>}
                          </Show>
                        </span>
                      )}
                    </Show>
                  </dd>
                  <dt>bosses</dt>
                  <dd>
                    <Show when={v().bosses.length > 0} fallback="0">
                      <For each={v().bosses}>
                        {(b, i) => (
                          <>
                            <Show when={i() > 0}>{", "}</Show>
                            <span title={`${stamp(b.ts)} · entry ${b.entry}`}>{b.name ?? `entry ${b.entry}`}</span>
                          </>
                        )}
                      </For>
                    </Show>
                  </dd>
                  <dt>deaths</dt>
                  <dd class="mono">{num(deaths())}</dd>
                </dl>

                <h2 class="section">members</h2>
                <div class="scroller">
                  <table>
                    <thead>
                      <tr>
                        <th>member</th>
                        <th>role</th>
                        <th>status</th>
                        <th class="right">level</th>
                        <th class="right">deaths</th>
                        <th>where</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={v().members}>{(m) => <MemberRow m={m} />}</For>
                    </tbody>
                  </table>
                </div>

                <h2 class="section">
                  timeline
                  <InfoHint
                    label="about the timeline"
                    text={
                      "Every member's records on one clock, from the party's start: deaths, map transfers into and out of an instance, " +
                      "kills of elites and bosses (one line per victim, however many members were told of it, the killer named when it was a member), " +
                      "level-ups, each member's own party chat lines, a member leaving the group, and each member's run ending."
                    }
                  />
                </h2>
                <div class="chips views">
                  <For each={KIND_GROUPS}>
                    {(g) => (
                      <button class={hidden().has(g.label) ? "" : "on"} onClick={() => toggle(g.label)}>
                        {g.label} · {counts().get(g.label) ?? 0}
                      </button>
                    )}
                  </For>
                </div>
                <div class="scroller">
                  <table>
                    <thead>
                      <tr>
                        <th class="right">time</th>
                        <th>member</th>
                        <th>event</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={events()}>
                        {(e) => <EventRow e={e} view={v()} />}
                      </For>
                    </tbody>
                  </table>
                </div>
              </>
            );
          }}
        </Show>
      </Show>
    </div>
  );
}

function MemberRow(props: { m: PartyMember }) {
  const m = (): PartyMember => props.m;
  const where = (): PartyMember["where"] => m().where;
  return (
    <tr>
      <td>
        <span class={`swatch ${memberClass(m().index)}`} />
        <A href={`/run/${encodeURIComponent(m().runId)}`} title={m().runId}>
          {m().character || m().member}
        </A>
      </td>
      <td class="dim" title={m().member}>
        {m().role}
      </td>
      <td>
        <Show when={m().row} fallback={<span class="dim">—</span>}>
          {(r) => (
            <span class={statusTone(m().status!)} title={m().terminationDetail ?? statusTitle(m().status!) ?? ""}>
              {statusText(r())}
            </span>
          )}
        </Show>
      </td>
      <td class="right mono">
        <LevelXp level={m().level} xp={m().xp} compact />
      </td>
      <td class="right mono">{num(m().deaths)}</td>
      <td title={where() === null ? "" : `${whereIds(where()!)} · ${stamp(where()!.ts)}`}>{whereLabel(where(), mapName)}</td>
    </tr>
  );
}

/** What one timeline line says. Labels, with the detail on hover. */
function eventText(e: PartyEvent): string {
  switch (e.kind) {
    case "death":
      return e.map === null ? "died" : `died · ${mapName(e.map)}`;
    case "enter":
      return `entered ${mapName(e.map)}`;
    case "leave":
      return `left ${mapName(e.map)}`;
    case "kill":
      return `killed ${e.name ?? (e.entry === null ? "an elite" : `entry ${e.entry}`)}`;
    case "level":
      return `level ${e.level}`;
    case "chat":
      return e.text;
    case "left":
      return "left the group";
    case "end":
      return `run ended · ${e.reason}`;
  }
}

function EventRow(props: { e: PartyEvent; view: PartyView }) {
  const e = (): PartyEvent => props.e;
  const m = (): PartyMember | undefined => memberOf(props.view, e().member);
  const start = (): number | null => props.view.startedAt;
  return (
    <tr>
      <td class="right mono dim" title={stamp(e().ts)}>
        {start() === null ? stamp(e().ts) : fmtElapsed(e().ts - start()!)}
      </td>
      <td>
        <Show when={m()} fallback={<span class="dim">party</span>}>
          {(mm) => (
            <>
              <span class={`swatch ${memberClass(mm().index)}`} />
              {mm().character || mm().member}
            </>
          )}
        </Show>
      </td>
      <td
        class={e().kind === "death" ? "err" : e().kind === "chat" ? "" : e().kind === "end" ? "dim" : ""}
        title={e().kind === "kill" ? killTitle(e() as Extract<PartyEvent, { kind: "kill" }>, props.view) : ""}
      >
        <Show when={e().kind === "kill" && (e() as Extract<PartyEvent, { kind: "kill" }>).boss}>
          <span class="badge">boss</span>{" "}
        </Show>
        <Show when={e().kind === "chat"} fallback={eventText(e())}>
          <span class="mono">{eventText(e())}</span>
        </Show>
      </td>
    </tr>
  );
}

function killTitle(k: Extract<PartyEvent, { kind: "kill" }>, view: PartyView): string {
  const seen = k.seenBy.map((id) => memberOf(view, id)?.character || id).join(", ");
  return `${k.entry === null ? "entry unknown" : `entry ${k.entry}`} · reported to ${seen}`;
}
