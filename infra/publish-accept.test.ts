/**
 * The readback verifier, against a bucket in memory.
 *
 * The fixture is built the way the publisher builds the real one: private
 * responses are pushed through `runner/viewer/public-projection.ts`, wrapped in
 * the renderer's envelope, and laid out on the renderer's keys. So a clean
 * bucket here is a bucket the renderer could actually have written, and every
 * poisoned case below is the same bucket with exactly one thing wrong.
 *
 * No network, no `data/`, no credentials — like the rest of infra's suite.
 */

import { describe, expect, test } from "bun:test";
import {
  canonical,
  describeAcceptReport,
  httpSource,
  reprojectionFindings,
  scanBody,
  verifyPublication,
  type AcceptSource,
  type Finding,
} from "./publish-accept";
import { LIVE_PATH, MANIFEST_PATH } from "./publish-core";
import {
  PUBLIC_ATTRIBUTION,
  projectEntries,
  projectFleet,
  projectInfo,
  projectPositions,
  projectRunDetail,
  projectRuns,
  projectTrack,
  projectWorkspaceArtifact,
} from "../runner/viewer/public-projection";

// ------------------------------------------------------------- the fake bucket

/** A bucket that can only be read, which is the interface's whole point. */
class MemorySource implements AcceptSource {
  readonly objects = new Map<string, string>();
  readonly reads: string[] = [];
  /** What `head` reports per key; absent means "no Cache-Control on the object". */
  readonly cacheControl = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.objects.get(key) ?? null;
  }

  async head(key: string): Promise<{ size: number; cacheControl: string | null } | null> {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    return { size: Buffer.byteLength(body), cacheControl: this.cacheControl.get(key) ?? null };
  }
}

const RUN_ID = "accept-run-1";
const RUN_VER = "0123456789ab";
const RUN_BASE = `v1/run/${RUN_ID}/${RUN_VER}`;

/** A `CostView`: the figure itself, plus the actual/expected pair beside it. */
const COST_FIGURE = {
  usd: null,
  basis: "none" as const,
  asIfMetered: false,
  breakdown: null,
  priceId: null,
  asOf: null,
  note: "no price on file",
};
/** A `TokenTotals`, the shape `projectTokenTotals` names field by field. */
const TOKENS = {
  source: "reported" as const,
  contextTokens: 10,
  promptTokens: 20,
  completionTokens: 30,
  totalTokens: 50,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  turns: 4,
};
const COST_VIEW = { ...COST_FIGURE, actual: { ...COST_FIGURE }, expected: { ...COST_FIGURE } };

function envelope(payload: object): string {
  return JSON.stringify({ generatedAt: 1_700_000_000_000, attribution: PUBLIC_ATTRIBUTION, ...payload });
}

/** A private run row, poisoned the way a real one is: paths, a base URL, an objective. */
function privateRunRow(): Record<string, unknown> {
  return {
    runId: RUN_ID,
    model: "test/model",
    driver: "openai",
    harness: "wrathbench",
    shakeout: false,
    objective: "poison-objective-text",
    campaign: null,
    cell: null,
    extra: null,
    character: "Fixturely",
    race: 3,
    raceName: "Dwarf",
    class: 3,
    className: "Hunter",
    characterLabel: "Dwarf Hunter",
    platform: "openrouter",
    resolvedModel: "test/model",
    cliVersion: null,
    apiBase: "http://10.66.66.66:1234/v1",
    harnessVersion: "harness-0.5-1-gabc",
    comparability: null,
    startedAt: 1000,
    endedAt: 2000,
    terminationReason: "episode-limit",
    terminationDetail: "episode limit reached near Goldshire",
    pauseReason: "provider said 429: slow down, /home/operator/x",
    continuedFrom: null,
    level: 6,
    xp: 1234,
    money: 42,
    questsCompleted: 3,
    items: [{ name: "Worn Shortsword", count: 1, equipped: true, entry: 25, quality: 1 }],
    mtime: 5,
    bytes: 100,
    live: false,
    error: "/home/operator/runs/blew-up.log",
    tokens: null,
    cost: null,
    firstTs: 1000,
    lastTs: 2000,
    playtimeMs: 1000,
    modelResponses: 4,
  };
}

/** The clean bucket: what a renderer pass would have written for one run. */
function cleanBucket(): MemorySource {
  const src = new MemorySource();

  const runs = projectRuns({ runs: [privateRunRow()] } as never) as unknown as { runs: Record<string, unknown>[] };
  runs.runs[0]!["snapshot"] = {
    detail: `${RUN_BASE}/detail.json`,
    track: `${RUN_BASE}/track.json`,
    entries: `${RUN_BASE}/entries.json`,
    workspace: `${RUN_BASE}/workspace.json`,
  };
  const info = projectInfo({
    service: "wrathbench-viewer",
    publicMode: false,
    dashboard: "dist",
    dashboardBuild: "private-build-1",
    worldserver: null,
    now: 1_700_000_000_000,
  } as never);

  const artifacts: Record<string, string> = {
    "info.json": "v1/snap/aaaaaaaaaaaa/info.json",
    "runs.json": "v1/snap/bbbbbbbbbbbb/runs.json",
  };
  src.objects.set(artifacts["info.json"]!, envelope(info));
  src.objects.set(artifacts["runs.json"]!, envelope(runs));
  src.objects.set(
    MANIFEST_PATH,
    JSON.stringify({
      gen: "cafebabe1234",
      artifacts,
      generatedAt: 1_700_000_000_000,
      attribution: PUBLIC_ATTRIBUTION,
    }),
  );
  src.objects.set(
    LIVE_PATH,
    JSON.stringify({
      generatedAt: 1_700_000_000_000,
      attribution: PUBLIC_ATTRIBUTION,
      fleet: projectFleet({
        present: false,
        fleetPid: 4242,
        server: { phase: "idle", since: 0, build: "b", detail: "", updatedAt: 0 },
        jobs: [],
        accounts: [],
        paused: [],
        ended: [],
        now: 1_700_000_000_000,
      } as never),
      positions: projectPositions({ positions: [] } as never),
    }),
  );

  const detail = projectRunDetail({
    run: privateRunRow(),
    states: [],
    total: 0,
    tokens: TOKENS,
    cost: COST_VIEW,
    playtimeMs: 1000,
  } as never);
  const track = projectTrack({
    runId: RUN_ID,
    character: "Fixturely",
    model: "test/model",
    harnessVersion: "harness-0.5-1-gabc",
    points: [],
    moves: [],
  } as never);
  const entries = projectEntries({
    from: 0,
    total: 2,
    entries: [
      {
        i: 0,
        t: "meta",
        ts: 1000,
        start: 0,
        end: 1,
        runId: RUN_ID,
        harnessVersion: "harness-0.5-1-gabc",
        startedAt: 1000,
        config: { token: "sentinel-bearer-9f31ab", apiBase: "http://10.66.66.66:1234/v1" },
      },
      {
        i: 1,
        t: "tool_result",
        ts: 1100,
        start: 1,
        end: 2,
        name: "search_reference",
        isError: false,
        text: "== Kobold Camp ==\nThe kobolds of Elwynn are a nuisance to the local farmers.",
      },
    ],
  } as never);
  src.objects.set(`${RUN_BASE}/detail.json`, envelope(detail));
  src.objects.set(`${RUN_BASE}/track.json`, envelope(track));
  src.objects.set(`${RUN_BASE}/entries.json`, envelope(entries));
  const notes = "plan: talk to Marshal McBride, then Kobold Camp Cleanup";
  src.objects.set(
    `${RUN_BASE}/workspace.json`,
    envelope(
      projectWorkspaceArtifact({
        files: [
          { path: "notes.md", bytes: 57, mtime: 1_700_000_000_000, firstLine: notes, text: `${notes}\n` },
          { path: "lib/camp.ts", bytes: 22, mtime: 1_700_000_000_000, firstLine: "export const camp = 1;", text: "export const camp = 1;" },
        ],
      }),
    ),
  );
  return src;
}

/** Rewrite one object's body through `edit`, so a case differs in exactly one way. */
function poison(src: MemorySource, key: string, edit: (body: Record<string, unknown>) => void): MemorySource {
  const body = JSON.parse(src.objects.get(key)!) as Record<string, unknown>;
  edit(body);
  src.objects.set(key, JSON.stringify(body));
  return src;
}

function kinds(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.kind))].sort();
}

// ------------------------------------------------------------------- the walk

describe("verifyPublication", () => {
  test("a clean generation passes, and the counts are the bucket's", async () => {
    const src = cleanBucket();
    const report = await verifyPublication(src);
    expect(report.findings).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.gen).toBe("cafebabe1234");
    expect(report.runs).toBe(1);
    expect(report.runsWithArtifacts).toBe(1);
    // manifest + live + two aggregates + four per-run objects.
    expect(report.objects).toBe(8);
    expect(report.bytes).toBeGreaterThan(0);
    expect(describeAcceptReport(report)).toContain("cafebabe1234");
  });

  test("the projection stripped the poison the fixture was built with", async () => {
    // The fixture's private row carries an objective, a LAN base URL, a
    // free-text pause reason, an exception with a path and a bearer token in a
    // meta entry's config. A clean pass above means none of them reached an
    // object — which is what makes the poisoned cases below meaningful.
    const src = cleanBucket();
    for (const body of src.objects.values()) {
      for (const secret of [
        "poison-objective-text",
        "10.66.66.66",
        "/home/operator",
        "sentinel-bearer-9f31ab",
        "kobolds of Elwynn",
      ]) {
        expect(body).not.toContain(secret);
      }
    }
    // …while the names beside them survived (docs/DATA-AND-LEGAL.md, 2026-08-30).
    const runs = src.objects.get("v1/snap/bbbbbbbbbbbb/runs.json")!;
    expect(runs).toContain("Worn Shortsword");
    expect(runs).toContain("Goldshire");
    expect(runs).toContain('"pauseReason":"paused"');
    const report = await verifyPublication(src);
    expect(report.findings).toEqual([]);
  });

  test("nothing is fetched that the generation does not name", async () => {
    const src = cleanBucket();
    await verifyPublication(src);
    expect(src.reads[0]).toBe(MANIFEST_PATH);
    expect(new Set(src.reads).size).toBe(src.reads.length);
    for (const key of src.reads) expect(src.objects.has(key)).toBe(true);
  });

  test("a missing aggregate is a finding, not a crash", async () => {
    const src = cleanBucket();
    src.objects.delete("v1/snap/aaaaaaaaaaaa/info.json");
    const report = await verifyPublication(src);
    expect(report.missing).toEqual(["v1/snap/aaaaaaaaaaaa/info.json"]);
    expect(kinds(report.findings)).toEqual(["missing-object"]);
    // The walk still finished: the runs were still listed and checked.
    expect(report.runs).toBe(1);
  });

  test("a missing per-run object is a finding", async () => {
    const src = cleanBucket();
    src.objects.delete(`${RUN_BASE}/entries.json`);
    const report = await verifyPublication(src);
    expect(report.missing).toEqual([`${RUN_BASE}/entries.json`]);
  });

  test("a manifest that is not there stops the walk with one finding", async () => {
    const src = cleanBucket();
    src.objects.delete(MANIFEST_PATH);
    const report = await verifyPublication(src);
    expect(report.missing).toEqual([MANIFEST_PATH]);
    expect(report.objects).toBe(0);
  });

  test("a pre-#38 manifest with no artifacts map is reported as such", async () => {
    const src = cleanBucket();
    src.objects.set(
      MANIFEST_PATH,
      JSON.stringify({ gen: "cafebabe1234", generatedAt: 1, attribution: PUBLIC_ATTRIBUTION }),
    );
    const report = await verifyPublication(src);
    expect(report.findings.map((f) => f.detail).join()).toContain("no artifacts map");
  });

  test("cache-control is observed, never asserted", async () => {
    const src = cleanBucket();
    const report = await verifyPublication(src);
    // Bun's S3 writer cannot send the header, so the expected state is none.
    expect(report.cache.map((c) => `${c.kind} ${c.cacheControl}`)).toEqual([
      "mutable null",
      "mutable null",
      "immutable null",
    ]);
    expect(report.findings).toEqual([]);
    // And a bucket that did carry one reports it, still without failing.
    const withHeader = cleanBucket();
    withHeader.cacheControl.set(LIVE_PATH, "public, max-age=30");
    const second = await verifyPublication(withHeader);
    expect(second.cache.find((c) => c.key === LIVE_PATH)!.cacheControl).toBe("public, max-age=30");
    expect(second.findings).toEqual([]);
  });
});

// --------------------------------------------------------------- the content

describe("prohibited content", () => {
  test("an un-nulled apiBase on a published row is caught", async () => {
    const src = poison(cleanBucket(), "v1/snap/bbbbbbbbbbbb/runs.json", (body) => {
      (body["runs"] as Record<string, unknown>[])[0]!["apiBase"] = "http://10.66.66.66:1234/v1";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toEqual(["host-fact", "projection-drift", "withheld-field"]);
  });

  test("a free-text pauseReason is caught", async () => {
    const src = poison(cleanBucket(), "v1/snap/bbbbbbbbbbbb/runs.json", (body) => {
      (body["runs"] as Record<string, unknown>[])[0]!["pauseReason"] = "provider said 429: slow down";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("withheld-field");
    expect(kinds(report.findings)).toContain("projection-drift");
  });

  test("an operator objective is caught", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/detail.json`, (body) => {
      (body["run"] as Record<string, unknown>)["objective"] = "reach level 10 in Loch Modan";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("withheld-field");
  });

  test("a local filesystem path anywhere is caught", async () => {
    const src = poison(cleanBucket(), "v1/snap/bbbbbbbbbbbb/runs.json", (body) => {
      (body["runs"] as Record<string, unknown>[])[0]!["error"] = "ENOENT: /home/operator/runs/blew-up.log";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("filesystem-path");
  });

  test("a bearer value is caught even where the projection would allow the field", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/workspace.json`, (body) => {
      (body["files"] as Record<string, unknown>[])[0]!["text"] =
        "my key is sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA and I should not have written it";
    });
    const report = await verifyPublication(src);
    // A file's text is the model's own and the projection passes it whole, so
    // this is the value scan alone — and a credential is never excused as
    // model-authored.
    expect(kinds(report.findings)).toEqual(["credential"]);
  });

  test("a key the workspace projection does not name is caught", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/workspace.json`, (body) => {
      (body["files"] as Record<string, unknown>[])[1]!["abs"] = "lib/camp.ts, somewhere on the host";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toEqual(["projection-drift"]);
  });

  test("a bucket last written before the workspace still has its scratchpad read back", async () => {
    // The pointer an older publisher wrote: walked and scanned like any other
    // object the listing names, with no projector to be a fixed point of.
    const src = poison(cleanBucket(), "v1/snap/bbbbbbbbbbbb/runs.json", (body) => {
      const row = (body["runs"] as Record<string, unknown>[])[0]!;
      row["snapshot"] = { detail: `${RUN_BASE}/detail.json`, track: `${RUN_BASE}/track.json`, scratchpad: `${RUN_BASE}/scratchpad.json` };
    });
    src.objects.set(`${RUN_BASE}/scratchpad.json`, envelope({ text: "key sk-ant-oat01-AAAAAAAAAAAAAAAAAAAA" }));
    const report = await verifyPublication(src);
    expect(src.reads).toContain(`${RUN_BASE}/scratchpad.json`);
    expect(kinds(report.findings)).toEqual(["credential"]);
  });

  test("a minimap tile reference is caught", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/track.json`, (body) => {
      body["tileBase"] = "tiles/0/32_48.png";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("tile-reference");
    expect(kinds(report.findings)).toContain("projection-drift");
  });

  test("wiki text in a search_reference result is caught", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/entries.json`, (body) => {
      (body["entries"] as Record<string, unknown>[])[1]!["text"] =
        "== Kobold Camp ==\nThe kobolds of Elwynn are a nuisance.";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("wiki-text");
    expect(kinds(report.findings)).toContain("projection-drift");
  });

  test("a raw trajectory record smuggled into an entry is caught", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/entries.json`, (body) => {
      (body["entries"] as Record<string, unknown>[])[0]!["config"] = {
        token: "sentinel-bearer-9f31ab",
        apiBase: "http://10.66.66.66:1234/v1",
      };
    });
    const report = await verifyPublication(src);
    // The re-projection catches the key the entry allowlist does not name; the
    // value scans catch what is inside it.
    expect(kinds(report.findings)).toContain("projection-drift");
    expect(kinds(report.findings)).toContain("withheld-field");
    expect(kinds(report.findings)).toContain("host-fact");
  });

  test("the wiki dump filename inside an entry's comparability tuple is caught", async () => {
    // The shape found on the live bucket: a `comparability_restamped`
    // harness entry whose tuples carry the operator's dump file. Both halves
    // fire — the key rule on `wikiBundle`, the value scan on the filename —
    // and the value scan is the one that survives the wrapper being renamed.
    const src = poison(cleanBucket(), `${RUN_BASE}/entries.json`, (body) => {
      (body["entries"] as Record<string, unknown>[])[0]!["before"] = {
        harnessVersion: "harness-0.5-1-gabc",
        budget: { maxTurns: null },
        wikiBundle: { schemaVersion: "1", source: "wowwikifandomcom-20200223-history.xml.7z" },
      };
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("wiki-dump-source");
    expect(kinds(report.findings)).toContain("withheld-field");
    expect(report.residual).toEqual([]);
  });

  test("a missing or altered attribution line is caught", async () => {
    const src = poison(cleanBucket(), `${RUN_BASE}/track.json`, (body) => {
      body["attribution"] = "WrathBench";
    });
    const report = await verifyPublication(src);
    expect(kinds(report.findings)).toContain("attribution");
  });

  test("a path the MODEL wrote is a residual note, not a finding", async () => {
    // docs/PUBLIC-DASHBOARD.md, "The content boundary": model-authored text is
    // published as written. Counting it keeps it visible; failing on it would
    // contradict the operator's own decision.
    const src = poison(cleanBucket(), `${RUN_BASE}/workspace.json`, (body) => {
      const notes = (body["files"] as Record<string, unknown>[])[0]!;
      notes["text"] = "I tried to read /home/agent/notes.md and it was not there";
      // The listing's copy of a file's first line is the same model text.
      notes["firstLine"] = "I tried to read /home/agent/notes.md and it was not there";
    });
    const report = await verifyPublication(src);
    expect(report.findings).toEqual([]);
    expect(kinds(report.residual)).toEqual(["filesystem-path"]);
    expect(report.residual.map((f) => f.at)).toEqual(["files[0].firstLine", "files[0].text"]);
    expect(describeAcceptReport(report)).toContain("residual (model-authored");
  });
});

// ----------------------------------------------------------------- the units

describe("the checks themselves", () => {
  test("re-projection is a fixed point on a projected body", () => {
    const projected = projectRuns({ runs: [privateRunRow()] } as never);
    const body = { generatedAt: 1, attribution: PUBLIC_ATTRIBUTION, ...projected };
    expect(reprojectionFindings("v1/snap/x/runs.json", body)).toEqual([]);
  });

  test("re-projection ignores the snapshot pointers the renderer stamps after it", () => {
    const projected = projectRuns({ runs: [privateRunRow()] } as never) as unknown as { runs: Record<string, unknown>[] };
    projected.runs[0]!["snapshot"] = { detail: "v1/run/a/b/detail.json", track: "v1/run/a/b/track.json" };
    const body = { generatedAt: 1, attribution: PUBLIC_ATTRIBUTION, ...projected };
    expect(reprojectionFindings("v1/snap/x/runs.json", body)).toEqual([]);
  });

  test("re-projection names the field that differs", () => {
    const projected = projectRuns({ runs: [privateRunRow()] } as never) as unknown as { runs: Record<string, unknown>[] };
    projected.runs[0]!["objective"] = "poison";
    const found = reprojectionFindings("v1/snap/x/runs.json", { attribution: PUBLIC_ATTRIBUTION, ...projected });
    expect(found).toHaveLength(1);
    expect(found[0]!.at).toBe("runs[0].objective");
  });

  test("a body whose shape the projection cannot walk is malformed, not a crash", () => {
    const found = reprojectionFindings("v1/snap/x/runs.json", { runs: "not an array" });
    expect(found.map((f) => f.kind)).toEqual(["malformed"]);
  });

  test("the value scan reads a URL with a port as a host fact, and a plain https URL as neither", () => {
    expect(kinds(scanBody("k", { a: "http://worldserver:8086" }).findings)).toEqual(["host-fact"]);
    expect(scanBody("k", { a: "https://www.azerothcore.org" }).findings).toEqual([]);
  });

  test("the scrub's output is not a finding, and a container-absolute path still is", () => {
    // The regression detector for `runner/viewer/scrub-paths.ts` (operator,
    // 2026-09-11): the scrub makes a container path repo-relative, so a
    // published string that still carries the prefix means the scrub did not
    // run over it — and the readback has to say so. Under a key the scan does
    // not treat as model-authored, so both land in `findings`.
    expect(scanBody("k", { a: "at move (sdk/src/client.ts:123:9)" }).findings).toEqual([]);
    expect(kinds(scanBody("k", { a: "at move (/wrathbench/sdk/src/client.ts:123:9)" }).findings)).toEqual([
      "filesystem-path",
    ]);
  });

  test("the value scan does not read a fraction or a zone name as a path", () => {
    expect(scanBody("k", { a: "3/4 of the way to Kharanos", b: "Dun Morogh/Coldridge Valley" }).findings).toEqual([]);
  });

  test("the dump scan wants the archive suffix, so a bare XML filename is not a finding", () => {
    expect(kinds(scanBody("k", { a: "wowwikifandomcom-20200223-history.xml.7z" }).findings)).toEqual([
      "wiki-dump-source",
    ]);
    expect(scanBody("k", { a: "I parsed quests.xml and moved on" }).findings).toEqual([]);
  });

  test("canonical ordering makes the compare about content, not key order", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toEqual(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(JSON.stringify(canonical({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });
});

// ------------------------------------------------------- through the hostname

/**
 * `--base` reads the same generation over plain HTTP, through the custom domain
 * rather than the S3 API (docs/PUBLIC-DASHBOARD.md, "The architecture"). The
 * verifier above is indifferent to which source it is handed — that is the
 * point of `AcceptSource` having two methods and no third — so what is left to
 * pin is the source itself: how it joins a key, what it calls a miss, and that
 * it can carry a whole verification end to end with no credential in sight.
 */
describe("the HTTP source reads the same bucket through the host", () => {
  /** A host serving the same objects, with the headers a zone cache rule would add. */
  function host(objects: Map<string, string>): { fetch: typeof globalThis.fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const key = decodeURI(new URL(url).pathname.slice(1));
      const body = objects.get(key);
      if (body === undefined) return new Response("not found", { status: 404 });
      const headers = { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable" };
      if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(body, { status: 200, headers });
    }) as typeof globalThis.fetch;
    return { fetch: fetchImpl, urls };
  }

  test("a key becomes one URL under the base, trailing slashes and all", async () => {
    const h = host(new Map([["v1/manifest.json", "{}"]]));
    const src = httpSource("https://wrathbench-data.shard.page/", h.fetch);
    expect(await src.get("v1/manifest.json")).toBe("{}");
    expect(h.urls).toEqual(["https://wrathbench-data.shard.page/v1/manifest.json"]);
  });

  test("a run id keeps its separators — a key is a path, not one component", async () => {
    const key = "v1/run/e90-sonnet-2026-09-11/abc123/detail.json";
    const h = host(new Map([[key, '{"ok":true}']]));
    const src = httpSource("https://d.example", h.fetch);
    expect(await src.get(key)).toBe('{"ok":true}');
    expect(h.urls).toEqual([`https://d.example/${key}`]);
  });

  test("404 is a miss, not an error — which is what the verifier reports as missing", async () => {
    const h = host(new Map());
    const src = httpSource("https://d.example", h.fetch);
    expect(await src.get("v1/manifest.json")).toBeNull();
    expect(await src.head?.("v1/manifest.json")).toBeNull();
  });

  test("head reports what the edge says, which is where the TTLs actually live", async () => {
    const h = host(new Map([["v1/snap/abc/runs.json", "{}"]]));
    const src = httpSource("https://d.example", h.fetch);
    expect((await src.head?.("v1/snap/abc/runs.json"))?.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  test("a whole clean generation verifies through the host, with no credential", async () => {
    const h = host(cleanBucket().objects);
    const report = await verifyPublication(httpSource("https://d.example", h.fetch));
    expect(report.missing).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.runs).toBeGreaterThan(0);
  });
});
