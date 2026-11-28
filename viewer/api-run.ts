/**
 * A run's own routes, `/api/run/<id>` and everything under it: the run
 * detail, its clips and camera, the replay track, the trace windows, the
 * units nearby, the entries window, a raw line, the scratchpad and the live
 * SSE tail, and a fan-out character's replay feed under its session id. Over
 * the handle's shared state (`ApiContext`), its tails above all
 * (`api-tails.ts`); `createApi` (`api.ts`) hands every `/api/run/` path here.
 */

import { json, notFound, withheld } from "./http";
import type { RunDetailResponse, RunRow, TrackResponse } from "./api-types";
import { episodeOf, questsAcrossRestarts, trackFrom } from "./results";
import { ENTRIES_WINDOW } from "./public-keys";
import { rosterNameOf } from "./roster";
import { runCost } from "./pricing";
import { characterViewOf } from "./character";
import { creatureNamesOf, partyDetailOf } from "./party-marks";
import { bossKillsOf, isBossKill } from "./timeline-marks";
import { BOSS_ENTRIES } from "../runner/src/dungeons";
import {
  projectEntries,
  projectRunDetail,
  projectClips,
  projectTrack,
  projectTraceIndex,
  projectTraceSegment,
  projectNearby,
} from "./public-projection";
import { NEARBY_SPAN_MS } from "@wrathbench/inspector/codec/nearby";
import { scrubPathsText } from "./scrub-paths";
import { SEG_MS } from "@wrathbench/inspector/codec/trace";
import { nearbyWindow, traceIndex, traceSegment } from "@wrathbench/inspector";
import { fanoutSession, fanoutSessions, isFanoutRun, runSession } from "./runs-source";
import { parseFanoutSessionId } from "../runner/src/run-reader";
import { latestFrameResponse } from "./camera-live";
import { CLIP_CONTENT_TYPE, CLIP_MEDIA_ROUTE, clipMedia, clipsView, fileResponse, hadCamera, type ClipMediaKind } from "./camera";
import { readMoves, readScratchpad } from "./runs";
import { runDir } from "../runner/src/run-list";
import { moveViewsOf } from "./clickhouse";
import { playtimeMs, recordSegments, segmentsFrom } from "../runner/src/sessions";
import type { ApiContext } from "./api-context";
import type { TrackCore } from "./api-tails";

/**
 * How often the live tail rescans, and the biggest entries window a client may
 * ask for: the run page's own window (`ENTRIES_WINDOW`), which the publisher
 * reads through this handler too, so a smaller cap would cut the published
 * window and leave a hole in the private page's "load earlier".
 */
export const POLL_MS = 1000;
const WINDOW_MAX = ENTRIES_WINDOW;

/** The registry's dungeon bosses by entry (`runner/dungeons/`): elites by rank, so the rank alone does not say (`isBossKill`). */
const NAMED_BOSSES: ReadonlySet<number> = BOSS_ENTRIES;

/**
 * Where the `/entries` window that shows the moment `at` begins: the window
 * of `limit` entries with the last entry at or before `at` a quarter of the
 * way in, so a reader who jumped to a time has a little of what led up to it
 * and most of what came after. Clamped to the run, so a time before the first
 * entry is the first window and one past the last is the tail.
 */
function entriesWindowAt(entries: readonly { ts: number }[], at: number, limit: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.ts <= at) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return Math.max(0, Math.min(found - Math.floor(limit / 4), entries.length - limit));
}

/**
 * How long a terminated run's files must have been quiet before its track is
 * treated as final. Far past the collector's five-second poll, so the store
 * holds the last of its states and moves before anything is kept.
 */
export const TRACK_SETTLE_MS = 5 * 60_000;

/** How many settled runs' track cores are kept; each is one replay's points, inventory patches and moves. */
export const TRACK_MEMO_RUNS = 6;

/** Whether a request's `If-None-Match` names this ETag (weak comparison, as RFC 9110 has for it). */
function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (header === null) return false;
  if (header.trim() === "*") return true;
  const bare = (t: string): string => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => bare(t) === bare(etag));
}

/**
 * Where a `/stream` starts, as the client asked: the browser's `Last-Event-ID`
 * on a reconnect (the cursor the last connection's frames carried), else the
 * URL's `from`. Null when neither is a non-negative integer, which starts the
 * stream at the tail's end.
 */
export function streamStart(req: Request, url: URL): number | null {
  for (const raw of [req.headers.get("last-event-id"), url.searchParams.get("from")]) {
    if (raw === null || !/^\d+$/.test(raw.trim())) continue;
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

/** The run routes over the handle's shared state (`ApiContext`); null for a path that is not a run's. */
export function createRunApi(ctx: ApiContext): (req: Request, url: URL, path: string) => Promise<Response | null> {
  const {
    runsDir,
    store,
    publicMode,
    pub,
    struckFor,
    publicText,
    fleetRoster,
    tails,
    runRowOne,
    runRowAndLead,
    runTotals,
    withResolved,
    resultRuns,
    statesOfRun,
    stateItemsOfRun,
    withheldRun,
    closedWindows,
    traceSegs,
  } = ctx;
  const { tailFor, pin, unpin, scan, trackCores } = tails;

  /**
   * Whether a run can no longer change underneath its track: terminated, and
   * its files quiet for `TRACK_SETTLE_MS`, which is what lets the collector —
   * a five-second poll — have stored the last of its states and moves.
   */
  function isSettled(run: RunRow): boolean {
    return run.terminationReason !== null && run.mtime !== null && Date.now() - run.mtime >= TRACK_SETTLE_MS;
  }

  /**
   * The store-derived half of a run's track: its points with the inventory as
   * patches, and its moves. For a live run, read fresh every time. For a
   * settled one, read once and kept (`trackCores`): those rows cannot change
   * any more, and reading them is the expensive part of the route — a long
   * run's whole `items` history out of the store, hundreds of milliseconds and
   * tens of MB a call. Nothing invalidates an entry but eviction: the LRU
   * bound, `release`, and the run's tail being dropped.
   */
  async function trackCoreOf(runId: string, settled: boolean): Promise<TrackCore> {
    const held = settled ? trackCores.get(runId) : undefined;
    if (held !== undefined) {
      trackCores.delete(runId);
      trackCores.set(runId, held);
      return held;
    }
    const [states, items, moveRows] = await Promise.all([
      statesOfRun(runId),
      stateItemsOfRun(runId),
      store.moveRows(runId),
    ]);
    const core: TrackCore = {
      ...trackFrom(states, items),
      // Same fallback as the track's own points: a run whose moves the
      // collector has not reached yet still draws its intentions.
      moves: moveRows.length > 0 ? moveViewsOf(moveRows) : await readMoves(runsDir, runId),
    };
    if (settled) {
      trackCores.set(runId, core);
      while (trackCores.size > TRACK_MEMO_RUNS) trackCores.delete(trackCores.keys().next().value!);
    }
    return core;
  }

  /**
   * A fan-out character's replay feed, under its session id
   * (`<run-id>~<Character>`, `runs-source.ts`): `/track`, `/trace` and
   * `/trace/<t0>`, read as a run's are, off the character's own record and
   * the store's rows under that id (the collector keys them so). Its run's
   * row answers the rest: the model, the harness, whether the track can still
   * change. A public handle answers none: a fan-out run it publishes (a
   * `deadmines-solo` attempt) is published without its characters, so no
   * character's id is public. No travel marks: those are the
   * trajectory's, and the run's one trajectory is no one character's.
   */
  async function fanoutCharacterRoute(id: string, parent: string, character: string, rest: string): Promise<Response> {
    const session = runDir(runsDir, parent) === null ? null : fanoutSession(runsDir, id);
    if (session === null || publicMode) return notFound(`no such run: ${id}`);
    if (rest === "/trace") return pub(await traceIndex(session, Date.now()), projectTraceIndex, [parent]);
    const traceMatch = /^\/trace\/(\d+)$/.exec(rest);
    if (traceMatch !== null) {
      const t0 = Number(traceMatch[1]);
      if (!Number.isSafeInteger(t0) || t0 % SEG_MS !== 0) return notFound("no such trace window");
      const found = await traceSegment(session, t0, Date.now());
      if (found === null) return notFound("no trace in that window");
      return new Response(JSON.stringify(found.segment), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": found.closed ? "public, max-age=31536000, immutable" : "no-store",
        },
      });
    }
    if (rest !== "/track") return notFound(`no such route for ${id}`);
    const run = await runRowOne(parent);
    const core = await trackCoreOf(id, isSettled(run));
    const trace = await closedWindows(`${runsDir}\0${id}`, session, Date.now());
    const body: TrackResponse = {
      runId: id,
      characterName: character,
      model: run.model,
      harnessVersion: run.harnessVersion,
      points: core.points,
      inv: core.inv,
      moves: core.moves,
      travel: [],
      ...(trace === null ? {} : { trace }),
    };
    return pub(body, projectTrack, [parent]);
  }

  async function runRoute(req: Request, url: URL, path: string): Promise<Response | null> {
    const m = /^\/api\/run\/([^/]+)(\/.*)?$/.exec(path);
    if (m === null) return null;
    const runId = m[1]!;
    const rest = m[2] ?? "";
    // A fan-out character, under its session id: its replay feed and nothing else.
    const named = parseFanoutSessionId(runId);
    if (named !== null) return await fanoutCharacterRoute(runId, named.runId, named.character, rest);
    const dir = runDir(runsDir, runId);
    if (dir === null) return notFound(`no such run: ${runId}`);
    // Every per-run route, the trace windows and the nearby ring included: a
    // withheld run is not there, to a public handle.
    if (await withheldRun(runId)) return notFound(`no such run: ${runId}`);
    const tail = tailFor(runId, dir);

    if (rest === "" || rest === "/") {
      await scan(runId, tail);
      /*
       * The resolved model is the one fact here that does not grow: it is
       * observed once, in the run's first turn, and never revised. So it comes
       * off the memoised whole-file totals rather than the incremental tail —
       * one derivation, shared with the listing — and a run that stamped it at
       * write time short-circuits the scan entirely.
       */
      const { run: row, lead } = await runRowAndLead(runId);
      const run = withResolved(row, await runTotals(runId));
      /*
       * Playtime comes off the tail's own index rather than `runTotals`: the
       * tail is incremental, where a live run misses the (size, mtime) totals
       * cache on every poll and would re-read the whole file. Both paths run
       * the same `segmentsFrom`/`playtimeMs`, so the two pages agree by
       * construction.
       */
      const entries = tail.entries;
      // Off the tail rather than the served list: the tail sees every line,
      // and the listing's figure is read off every line too — a run whose last
      // record the feed does not serve must not close its segment early here.
      const lastTs = tail.lastTs;
      /*
       * The segment marks, accumulated by the tail as it indexes: every
       * `SEGMENT_MARKS` entry and the first entry with a timestamp (`ts > 0`
       * keeps an unparseable first line, which `scanRunTotals` drops outright,
       * from spending the no-meta bootstrap on a zero timestamp).
       */
      const marks = tail.segmentMarks;
      /*
       * Tokens, cost, coverage and speed ride the same incremental path: the
       * tail accumulates the cost as it indexes and holds the token and speed
       * derivations until it grows (`TrajectoryTail.tokens`), so a live run's
       * figure grows with its trajectory instead of waiting for the (size,
       * mtime) totals cache to miss, and a warm poll does not re-walk every
       * entry the run ever wrote.
       */
      const tokens = tail.tokens;
      /*
       * The freeplay character this run is one attempt of, aggregated across the
       * whole chain (`character.ts`). Every figure the runner records is per
       * attempt, so without this the run page shows a twelfth session's quests
       * under a character that has been playing for a fortnight.
       *
       * Gated on the run being freeplay at all — the stamped tier, or a
       * `continuedFrom` for a run whose metadata predates the stamp — so a
       * scored run's page pays nothing for it. Behind the gate it is the
       * listing's own rows, and this route is why that listing is held on a
       * window at all: `resultRuns` shares one build for
       * `RESULT_RUNS_CACHE_MS`, so a burst of run pages pays for one, and this
       * page and `/api/ladder` cannot disagree about what a character is.
       */
      const whole =
        run.continuedFrom !== null || episodeOf(run).episode === "freeplay"
          ? characterViewOf(runId, await resultRuns())
          : null;
      /*
       * `characterViewOf` is universal since — every run has a
       * character, a scored one's being a chain of one — but a card and a strip
       * reading "attempt 1 of 1" are noise standing where a fact should be
       * (`hasLineage`, lineage.ts). So the field stays absent below the
       * threshold that gate has always drawn, and a reader who wants the
       * degenerate view asks `/api/character/<id>` for it.
       */
      const character = whole !== null && whole.attempts > 1 ? whole : null;
      // A store session has no trajectory to mark its sessions: its record's span is its one.
      const sessions = run.source === "store" ? recordSegments(run) : segmentsFrom(marks);
      const states = await statesOfRun(runId);
      /*
       * A party member's own records (`party-marks.ts`), off the tail just
       * scanned and the run's own files: gated on the row's stamp, so every
       * other run's page pays nothing and keeps its shape.
       */
      const party = run.party === undefined ? null : await partyDetailOf(runsDir, runId, dir, tail);
      /*
       * The run's boss kills, for the timeline's chapters (`timeline-marks.ts`):
       * rank-3 victims and the registry's dungeon bosses off the same kill
       * marks, each named as the run's own client cache answered its entry.
       */
      const bossMarks = tail.kills.filter((k) => isBossKill(k, NAMED_BOSSES));
      const bosses = bossKillsOf(bossMarks, NAMED_BOSSES, creatureNamesOf(dir, new Set(bossMarks.map((k) => k.entry).filter((e): e is number => e !== null))));
      const body: RunDetailResponse = {
        /*
         * The row's quest count is the newest sample's, and the counter is the
         * running process's: a run resumed in place reads zero after the
         * resume. This route holds the series, so it serves the whole run's
         * count — the figure `ResultRun.questsCompleted` carries, from the same
         * `questsAcrossRestarts`.
         */
        run: { ...run, questsCompleted: questsAcrossRestarts(states) ?? run.questsCompleted },
        states,
        total: entries.length,
        tokens,
        cost: runCost({
          run,
          tokens,
          reportedUsd: tail.reportedCostUsd,
          coverage: tail.costCoverage,
        }),
        playtimeMs: playtimeMs(sessions, { lastTs, live: run.live, now: Date.now() }),
        // The segments that figure sums, so the page's charts close the same
        // pauses the playtime does (`sessions.ts`).
        sessions,
        /*
         * The models-table row this run links to, so the page need not fetch
         * the whole models aggregate for one name. Off the roster the config
         * store holds now (`fleetRoster`, shared on its short window), like
         * `/api/models` itself. Public-safe: `models.json` publishes every row
         * name. A cold run's published detail is only re-rendered on the full
         * pass, so a renamed roster entry reaches it that late.
         */
        rosterName: rosterNameOf(
          fleetRoster(),
          run.model,
          run.comparability?.effort ?? null,
          run.comparability?.compactWindow ?? null,
        ),
        // Same incremental path as tokens and cost: the tail accumulates the
        // milestone marks as it indexes, so a live run's line grows with it.
        achievements: tail.achievements,
        taxi: tail.taxi,
        leveling: tail.leveling,
        deaths: tail.deaths,
        // Only where there is one: a run with none keeps the body, and the published key, it had.
        ...(bosses.length > 0 ? { bosses } : {}),
        spells: tail.spells,
        talents: tail.talents,
        trades: tail.trades,
        // Same incremental path again: a live run's rate advances with the tail
        // rather than waiting on the (size, mtime) totals cache to miss.
        tps: tail.tps,
        // The turns spent reflecting, from the same pass: the feed accents them
        // by turn, and the window that opens one can sit far above whatever
        // slice of entries the page happens to have loaded.
        reflections: tail.reflections,
        // Absent, not null, on a run with no character: an optional field the page
        // falls back from, the same shape the facts above take.
        ...(character === null ? {} : { character }),
        ...(party === null ? {} : { party }),
        // A fan-out run's characters, so the page can open each one's session,
        // and the one whose level and xp the run's row reads.
        ...(isFanoutRun(runsDir, runId) ? { fanout: fanoutSessions(runsDir, runId) } : {}),
        ...(lead === null ? {} : { fanoutLead: lead }),
        // A label off meta.json, read here rather than carried on the row:
        // it is no part of the listing and no store column holds it.
        ...(hadCamera(runsDir, runId) ? { camera: true as const } : {}),
      };
      return pub(body, projectRunDetail, [runId]);
    }

    /*
     * The camera's clips (`camera.ts`): the list off `camera/clips.json`, and
     * each clip's video and poster, which only a clip the list names reaches
     * and the frames never do. Public mode serves both too: the snapshot
     * publishes the same clips, and the list crosses `projectClips`, which
     * redacts each caption as model text is. A run with no clips is a 404 to
     * a public handle and `null` to a private one: the private pages ask on
     * every run, filmed or not (the `camera` label lags a live run's filming),
     * and a 404 there is a console error on every page.
     */
    if (rest === "/clips") {
      const body = clipsView(runsDir, runId);
      if (body === null) return publicMode ? notFound("no clips") : json(null);
      return pub(body, projectClips, [runId]);
    }
    /*
     * The newest camera frame and its `{seq, t}` (`camera-live.ts`), for the
     * run page's live still. Private only: frames are never published, and
     * nothing on the public site may act as a live view of the world, so a
     * public handle has no such route, before anything is read.
     */
    if (rest.startsWith("/camera/")) {
      if (publicMode) return notFound("no such route");
      const live = latestFrameResponse(req, runsDir, runId, rest);
      if (live !== null) return live;
    }
    const media = CLIP_MEDIA_ROUTE.exec(rest);
    if (media !== null) {
      const kind = media[2] as ClipMediaKind;
      const hit = clipMedia(runsDir, runId, media[1]!, kind);
      if (hit === null) return notFound("no such clip");
      return fileResponse(req, hit.file, hit.stat, CLIP_CONTENT_TYPE[kind]);
    }

    if (rest === "/track") {
      // The replay feed: the same position shape the live map
      // consumes, read from one finished run instead of every live one.
      const run = await runRowOne(runId);
      /*
       * Where this attempt sits in its character, so the map's transport can step
       * to the one either side of it without a second fetch.
       *
       * Deliberately the same expression the detail route gates its `character`
       * with, and the same `characterViewOf` call behind it: a scored run's
       * replay pays nothing, a freeplay one pays what its run page already
       * pays — and pays it only once, since both routes take the listing off
       * the same `RESULT_RUNS_CACHE_MS` window — and the two routes cannot
       * come to different answers about who continues whom.
       */
      const whole =
        run.continuedFrom !== null || episodeOf(run).episode === "freeplay"
          ? characterViewOf(runId, await resultRuns())
          : null;
      // Same threshold as the detail route's, for the same reason: a bar with
      // no attempt either side of it has nothing to step to.
      const character = whole !== null && whole.attempts > 1 ? whole : null;
      const trace = await traceSegs(runId, Date.now());
      // The travel marks ride the same incremental tail the run page reads, so
      // a replay opened after the page — and every publisher pass, which asks
      // for both — pays nothing for them; a cold replay pays the page's scan.
      await scan(runId, tail);
      const settled = isSettled(run);
      const core = await trackCoreOf(runId, settled);
      const body: TrackResponse = {
        runId,
        characterName: run.character,
        model: run.model,
        harnessVersion: run.harnessVersion,
        // The points, and the inventory along them as patches (`inv`), so the
        // replay pip can show what the live pip shows.
        points: core.points,
        inv: core.inv,
        // The intentions beside the track: same run, different cadence.
        moves: core.moves,
        // How the character crossed each gap — flights, hearths, graveyard
        // releases — derived from the trajectory at read time, never stored.
        travel: tail.travel,
        // Absent, not null, on a run with no character — as on the detail route.
        ...(character === null
          ? {}
          : {
              character: {
                characterId: character.characterId,
                attempt: character.attempt,
                attempts: character.attempts,
                previous: character.previous,
                next: character.next,
              },
            }),
        // The closed trace windows, each `/trace/<t0>`. Absent on a run with
        // none, so a track from before the recorder is the bytes it was.
        ...(trace === null ? {} : { trace }),
        // A fan-out run's characters, whose tracks the map replays together.
        ...(isFanoutRun(runsDir, runId) ? { fanout: fanoutSessions(runsDir, runId) } : {}),
      };
      if (!settled) return pub(body, projectTrack, [runId]);
      /*
       * A settled run's track revalidates rather than re-downloads: a weak
       * ETag over the body as served (weak because the bytes on the wire
       * depend on the encoding), answered with a 304 while it holds. Not
       * `immutable`, although the run cannot change: the body also carries
       * the character's `next` attempt, which appears when a continuation
       * starts, and the trace windows, the last of which may still be settling.
       */
      const text = JSON.stringify(publicMode ? struckFor(projectTrack(body), [runId]) : body);
      const etag = `W/"${Bun.hash(text).toString(36)}"`;
      // `Vary` on the 304 too: it stands for a body that varied on it.
      const headers = { etag, "cache-control": "no-cache", vary: "Accept-Encoding" };
      if (ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", ...headers } });
    }

    if (rest === "/trace") {
      // The trace index: the closed windows and the tail so far. Never cached:
      // the tail moves with every drain.
      return pub(await traceIndex(runSession(runsDir, runId), Date.now()), projectTraceIndex, [runId]);
    }

    const traceMatch = /^\/trace\/(\d+)$/.exec(rest);
    if (traceMatch !== null) {
      const t0 = Number(traceMatch[1]);
      if (!Number.isSafeInteger(t0) || t0 % SEG_MS !== 0) return notFound("no such trace window");
      const found = await traceSegment(runSession(runsDir, runId), t0, Date.now());
      if (found === null) return notFound("no trace in that window");
      /*
       * A closed window is settled (`SETTLE_MS` past its end), so its segment
       * can never change and is cached as an immutable asset is; the window
       * still open or settling is served as it stands, uncached. Its chat
       * lines are the model's own text, so a public body is struck like the
       * run's other text (`publicText`).
       */
      const body = JSON.stringify(publicMode ? projectTraceSegment(found.segment) : found.segment);
      return new Response(publicMode ? publicText(body, [runId]) : body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": found.closed ? "public, max-age=31536000, immutable" : "no-store",
        },
      });
    }

    if (rest === "/nearby") {
      /*
       * The units around a live character, for the live map: the last `span`
       * ms of the run's ring (the inspector's `nearbyWindow`, at most its reach), one
       * window. Never cached — the ring moves every drain — and an empty
       * window, not a 404, for a run with none: no units is a state. In public
       * mode the window crosses `projectNearby`.
       */
      const spanParam = Number(url.searchParams.get("span") ?? NEARBY_SPAN_MS);
      const span = Number.isFinite(spanParam) ? spanParam : NEARBY_SPAN_MS;
      return pub(await nearbyWindow(runSession(runsDir, runId), span, Date.now()), projectNearby);
    }

    if (rest === "/entries") {
      await scan(runId, tail);
      const total = tail.entries.length;
      const limit = Math.min(WINDOW_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? ENTRIES_WINDOW)));
      const fromParam = url.searchParams.get("from");
      // `at` is the timeline's jump to a time: the window that holds that moment (`entriesWindowAt`).
      const atParam = Number(url.searchParams.get("at") ?? Number.NaN);
      const from =
        fromParam !== null
          ? Math.max(0, Number(fromParam))
          : Number.isFinite(atParam)
            ? entriesWindowAt(tail.entries, atParam, limit)
            : Math.max(0, total - limit);
      const page = { from, total, entries: tail.entries.slice(from, from + limit) };
      // Public mode serves the same window the snapshot publishes: each entry
      // through the per-type allowlist and the game-prose redactor.
      return pub(page, projectEntries, [runId]);
    }

    const rawMatch = /^\/raw\/(\d+)$/.exec(rest);
    if (rawMatch !== null) {
      if (publicMode) return withheld();
      await scan(runId, tail);
      const raw = await tail.raw(Number(rawMatch[1]));
      if (raw === null) return notFound("no such entry");
      return new Response(raw, {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // The scratchpad is the model's own notes, published as written since
    // 2026-08-30 (docs/DATA-AND-LEGAL.md, "Trajectory logs"); no public gate.
    // It has no projector — it is text, not a body — so the path scrub every
    // projector applies is applied here by hand when the handle is public.
    if (rest === "/scratchpad") {
      const text = readScratchpad(runsDir, runId);
      if (text === null) return notFound("no scratchpad");
      return new Response(publicMode ? publicText(scrubPathsText(text), [runId]) : text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (rest === "/stream") {
      /*
       * The live tail has no projected form: it pushes entry batches as they
       * are written, and a public reader's window is the static snapshot's
       * one published tail instead (the SPA guards SSE off in snapshot mode).
       * Withheld rather than projected so public mode is not a set of routes
       * an operator has to remember — GitHub issue #30.
       */
      if (publicMode) return withheld();
      await scan(runId, tail);
      /*
       * The stream's own position in the shared tail. `scan` hands what it
       * newly read only to the caller that ran it, and every reader of this
       * run shares the one tail — a second tab, the run page's own detail
       * poll, `/entries`, `/track` — so forwarding `scan`'s return value lost
       * whatever another reader happened to read first. Each stream sends
       * `entries.slice(cursor)` instead, after any scan by anyone, and starts
       * over from the top when the tail was rebuilt under it (a truncated or
       * rotated file; `generation`).
       *
       * Where it starts is the client's to say. The run page loads its window
       * from `/entries` and only then opens this, so a stream starting at the
       * tail's end would drop whatever was written between the two; the page
       * passes `?from=` (the index of the first entry it does not hold — an
       * entry's `i`, which is its index in `entries`) and the stream sends
       * from there. Every frame that moves the cursor carries it as the SSE
       * `id`, so the browser's own reconnect sends it back as `Last-Event-ID`,
       * which wins over the URL's `from`: a reconnect resumes where the last
       * connection stopped, neither losing the gap nor replaying what it
       * already delivered. A start past the tail's end means the file was
       * rebuilt shorter since the client read it, so that starts over at 0,
       * as a rebuild under an open stream does. No start at all is the end.
       */
      const start = streamStart(req, url);
      let cursor = start === null ? tail.entries.length : start > tail.entries.length ? 0 : start;
      let gen = tail.generation;
      let timer: ReturnType<typeof setInterval> | undefined;
      let closed = false;
      // Pinned while open: eviction must never drop a tail a stream is reading,
      // or the stream would keep an orphan while `tailFor` built a second one.
      pin(runId, tail);
      const unpinOnce = (): void => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        unpin(runId);
      };
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // `id` only on the frames that move the cursor: a browser keeps the
          // last id it saw across frames that carry none.
          const send = (data: unknown, id?: number): void => {
            if (closed) return;
            try {
              const head = id === undefined ? "" : `id: ${id}\n`;
              controller.enqueue(enc.encode(`${head}data: ${JSON.stringify(data)}\n\n`));
            } catch {
              unpinOnce(); // the client went away between ticks
            }
          };
          /** Everything past the cursor, as one batch; false when there was nothing. */
          const flush = (): boolean => {
            if (tail.generation !== gen) {
              gen = tail.generation;
              cursor = 0;
            }
            if (cursor >= tail.entries.length) return false;
            const added = tail.entries.slice(cursor);
            cursor = tail.entries.length;
            // The token figure is the tail's memo: one derivation per batch
            // however many streams are open.
            send({ entries: added, tokens: tail.tokens }, cursor);
            return true;
          };
          send({ hello: runId, total: tail.entries.length }, cursor);
          // What was written before the stream opened, at once rather than on
          // the first tick.
          flush();
          timer = setInterval(() => {
            void scan(runId, tail)
              .then(() => {
                // A heartbeat keeps proxies and fetch timeouts from calling it dead.
                if (!flush()) send({ tick: Date.now() });
              })
              .catch(() => undefined);
          }, POLL_MS);
        },
        cancel() {
          unpinOnce();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    }

    return notFound("no such path");
  }

  return runRoute;
}
