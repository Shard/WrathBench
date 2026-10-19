/**
 * A probe campaign definition: the STATIC half of a campaign, as data.
 *
 * A campaign is a matrix: cells (the start: race and class) × arms (the
 * harness: image, command, args) × assignments (the models, which are the
 * store row's and change while the definition stands still). What a run of it
 * IS — its question, its cells, its arms, its leash, what ends it and what
 * counts as a cell done — is a JSON document, `runner/campaigns/<id>@<version>.json`,
 * validated here at the boundary.
 *
 * A definition reaches the fleet by being PUBLISHED (`campaign-publish.ts`),
 * which writes it into the config store under `campaign-defs/<id>@<version>`
 * with its content hash and the commit it came from. The store refuses a
 * second write to that key with a different hash, so a published version is
 * never edited: a change is a new version. That is the rule a wrong episode
 * default is held to ("replaced by a new id, never widened in place"),
 * applied to campaigns, because a cell whose meaning changes under the same id
 * silently re-scopes every run already recorded against it. Nothing compiles a
 * definition into an image, so adding a campaign needs no release.
 */

import { z } from "zod";
import { parseCompactWindow } from "./config";
import { ARM_RESERVED_FLAGS, RUN_FLAGS, flagsOf } from "./run-flags";
import { partyDefinitionSchema, type PartyMember } from "./party";

/** Names a campaign id, a cell id and an arm id must all survive: safe in a run id and a path. */
export const CAMPAIGN_NAME = /^[A-Za-z0-9._-]+$/;

/** The command an arm with no `command` runs: this repository's runner. */
export const DEFAULT_RUN_COMMAND: readonly string[] = ["bun", "runner/src/run.ts"];

/**
 * An OCI image reference: `[registry[:port]/]repo[/more][:tag][@sha256:<64 hex>]`.
 * A port is read only when a path follows it, so `repo:5000` is a tag.
 */
const IMAGE_REF =
  /^(?<name>[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+(?=\/))?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$/;

/**
 * Why an arm's image reference cannot be launched, or null when it can. A
 * ref must name a build: a tag, a digest, or both. An untagged ref and
 * `:latest` both mean "whatever the registry says today", which a comparison
 * between named builds cannot be. Which registries a run pod may pull from is
 * the launcher's rule, not the definition's.
 */
export function imageRefProblem(ref: string): string | null {
  const m = IMAGE_REF.exec(ref);
  if (m === null) return `${JSON.stringify(ref)} is not an image reference ([registry/]repo[:tag][@sha256:<digest>])`;
  const tag = m.groups?.["tag"];
  const digest = m.groups?.["digest"];
  if (tag === undefined && digest === undefined) return `${ref} names no build: give it a tag or a @sha256: digest`;
  if (tag === "latest") return `${ref}: :latest names no build — use the build's own tag or its digest`;
  return null;
}

const nameSchema = z.string().min(1).max(64).regex(CAMPAIGN_NAME);

const cellSchema = z
  .object({
    /** Safe in a run id and a path; recorded on the run as `cell`. */
    id: nameSchema,
    /** The client's own race and class ids (`enum Races`/`enum Classes` in SharedDefines.h). */
    race: z.number().int().positive(),
    class: z.number().int().positive(),
    /** Why the cell is what it is, when that is not obvious — e.g. a substitute class. */
    note: z.string().min(1).optional(),
  })
  .strict();

const armSchema = z
  .object({
    /** Safe in a run id and a path; recorded on the run as `arm`. */
    id: nameSchema,
    note: z.string().min(1).optional(),
    /** The image a run of this arm executes. Absent: the fleet's release image at launch. */
    image: z
      .string()
      .min(1)
      .superRefine((v, ctx) => {
        const problem = imageRefProblem(v);
        if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
      })
      .optional(),
    /** The container command. Absent: `bun runner/src/run.ts`. */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** Appended after the supervisor's own argv; opaque to the supervisor, validated by the image. */
    args: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Where a run of the definition starts. `fresh` (the default, and what a
 * definition that says nothing means) is a level-1 character the model names
 * and creates. `staged` is a character the operator's stager put in place
 * before the launch — a fixture scenario applied to it, level and loadout
 * included (the operator's loadout decision for the Deadmines party,
 * 2026-10-19) — which the run is launched on by name (`--character`) and
 * keeps through hygiene. `level` is the level the scenario stages, stated so
 * the launch note can say it rather than assume it.
 */
const startSchema = z.union([
  z.literal("fresh"),
  z
    .object({
      /** The fixture scenario the stager applies (infra/fixtures/scenarios.ts). */
      staged: nameSchema,
      level: z.number().int().min(1).max(80),
    })
    .strict(),
]);
export type CampaignStart = z.infer<typeof startSchema>;

/** A campaign definition, as `runner/campaigns/<id>@<version>.json` holds it. */
export const campaignDefinitionSchema = z
  .object({
    id: nameSchema,
    /** 1, 2, …; a published version is never edited. */
    version: z.number().int().positive(),
    /** The one question the sweep answers. */
    question: z.string().min(1),
    /** Why the definition is shaped the way it is: the reasoning a reader would otherwise ask for. */
    note: z.string().min(1).optional(),
    cells: z.array(cellSchema).min(1),
    arms: z.array(armSchema).min(1),
    /** Rendered verbatim into the prompt's delimited operator-objective block; null for the standing goal alone. */
    objective: z.string().min(1).nullable(),
    /** End the run on the first server-observed level at or above this (`level-target`); null for none. */
    stopAtLevel: z.number().int().min(2).max(80).nullable(),
    budget: z
      .object({
        /** The ceiling, on the play clock (a resumed run continues it). */
        episodeMs: z.number().int().positive(),
        idleMs: z.number().int().positive(),
        /** Null: the no-XP watchdog is off. */
        noXpMs: z.number().int().positive().nullable(),
        /** The runaway guard, never a task budget. */
        maxToolCalls: z.number().int().positive(),
      })
      .strict(),
    wiki: z.boolean(),
    wikiCoords: z.boolean(),
    /** A paused run resumes, rather than ending as a failed attempt. */
    resume: z.boolean(),
    /** Abandon an (assignment, arm, cell) square after this many launches, counted or not; null never. */
    maxAttemptsPerCell: z.number().int().positive().nullable(),
    /**
     * Where a run starts. Absent is `fresh`. Optional with no default, so a
     * definition written before it hashes as it always did.
     */
    start: startSchema.optional(),
    /**
     * A party (docs/proposals/GROUP-PLAY.md): each square's launch is this
     * many runs of the assignment's model at once, one staged character each,
     * started, stopped and counted together. Absent on every definition that
     * is not one; optional for the hash's sake like `start`.
     */
    party: partyDefinitionSchema.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const dupes = (ids: readonly string[]): string[] => [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    for (const id of dupes(d.cells.map((c) => c.id))) ctx.addIssue({ code: "custom", path: ["cells"], message: `cell ${id} is declared twice` });
    for (const id of dupes(d.arms.map((a) => a.id))) ctx.addIssue({ code: "custom", path: ["arms"], message: `arm ${id} is declared twice` });
    if (d.wikiCoords && !d.wiki) ctx.addIssue({ code: "custom", path: ["wikiCoords"], message: "wikiCoords needs the reference wiki, and wiki is false" });
    if (d.party !== undefined) {
      // Characters the model did not create: they are the stager's.
      if (d.start === undefined || d.start === "fresh") {
        ctx.addIssue({ code: "custom", path: ["start"], message: "a party starts on staged characters: give start { staged, level }" });
      }
      // Each member carries its own objective, rendered in its own block.
      if (d.objective !== null) {
        ctx.addIssue({ code: "custom", path: ["objective"], message: "a party's objective is per member (party.members[].objective); the top-level objective is null" });
      }
      // The cell is the party; its start reads as the leader's, so a reader
      // of the cell is never told a start no member had.
      const leader = d.party.members[0];
      d.cells.forEach((c, i) => {
        if (leader !== undefined && (c.race !== leader.race || c.class !== leader.class)) {
          ctx.addIssue({
            code: "custom",
            path: ["cells", i],
            message: `a party's cell carries its leader's start (race ${leader.race}, class ${leader.class}), not race ${c.race}, class ${c.class}`,
          });
        }
      });
    }
    // Harness drift between builds is as large as a model difference, so the
    // arms of a comparison are always named builds: a floating arm would be
    // whatever master was on the day each of its runs launched.
    if (d.arms.length > 1) {
      const floating = d.arms.filter((a) => a.image === undefined).map((a) => a.id);
      if (floating.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["arms"],
          message: `a definition with more than one arm pins every arm's image; ${floating.join(", ")} ${floating.length === 1 ? "floats" : "float"} on the release image`,
        });
      }
    }
    d.arms.forEach((a, i) => {
      const args = a.args ?? [];
      for (const f of dupes(flagsOf(args))) {
        ctx.addIssue({ code: "custom", path: ["arms", i, "args"], message: `arm ${a.id}: --${f} is given twice` });
      }
      const reserved = flagsOf(args).filter((f) => ARM_RESERVED_FLAGS.includes(f));
      if (reserved.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["arms", i, "args"],
          message: `arm ${a.id}: ${reserved.map((f) => `--${f}`).join(", ")} ${reserved.length === 1 ? "is" : "are"} the definition's or the supervisor's to set, never an arm's`,
        });
      }
      // The window is this runner's own flag on any image that runs it, so a
      // value it would refuse is caught here, not by three failed launches.
      const wi = args.indexOf("--compact-window");
      if (a.command === undefined && wi >= 0) {
        try {
          parseCompactWindow(args[wi + 1]);
        } catch (err) {
          ctx.addIssue({ code: "custom", path: ["arms", i, "args"], message: `arm ${a.id}: ${(err as Error).message}` });
        }
      }
      // An arm on the release image runs this checkout's run.ts, so its args
      // can be checked here rather than at the first launch. An arm with its
      // own image or command carries flags only that image knows.
      if (a.image === undefined && a.command === undefined) {
        const unknown = flagsOf(args).filter((f) => !(RUN_FLAGS as readonly string[]).includes(f));
        if (unknown.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["arms", i, "args"],
            message: `arm ${a.id} runs the release image, whose run.ts has no ${unknown.map((f) => `--${f}`).join(", ")}`,
          });
        }
      }
    });
  });

export type CampaignDefinition = z.infer<typeof campaignDefinitionSchema>;
export type CampaignCell = CampaignDefinition["cells"][number];
export type CampaignArm = CampaignDefinition["arms"][number];

/** What a publish recorded about where a definition came from. Informational: the hash is the identity. */
export const campaignSourceSchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    path: z.string().min(1),
    /** The origin branches that contained the commit when it was published. */
    branch: z.array(z.string().min(1)),
  })
  .strict();
export type CampaignSource = z.infer<typeof campaignSourceSchema>;

/** A `campaign-defs/<id>@<version>` row: a definition as it was published. */
export const publishedCampaignSchema = z
  .object({
    definition: campaignDefinitionSchema,
    hash: z.string().regex(/^sha256:[0-9a-f]{16}$/),
    source: campaignSourceSchema,
    publishedAt: z.number().int().positive(),
  })
  .strict();
export type PublishedCampaignDoc = z.infer<typeof publishedCampaignSchema>;

/** The store row prefix only publishing writes. */
export const CAMPAIGN_DEFS_PREFIX = "campaign-defs/";

/** `race-probe@1`: how a definition is named on the command line, in the store and in messages. */
export function campaignRef(def: { id: string; version: number }): string {
  return `${def.id}@${def.version}`;
}

/** `campaign-defs/race-probe@1`. */
export function campaignDefKey(def: { id: string; version: number }): string {
  return `${CAMPAIGN_DEFS_PREFIX}${campaignRef(def)}`;
}

/**
 * Parse `id@version`. Null for anything else — a bare id included, because a
 * reference that does not say which version it is would let a newer
 * definition re-target it silently.
 */
export function parseCampaignRef(s: string): { id: string; version: number } | null {
  const m = /^([A-Za-z0-9._-]+)@([1-9][0-9]*)$/.exec(s);
  if (m === null) return null;
  return { id: m[1]!, version: Number(m[2]) };
}

/** JSON with every object's keys sorted, so the hash is a function of content, not of key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * A definition's content hash: `sha256:<16 hex>` (the prompt hash's shape)
 * over its canonical JSON, exactly as written — the schema fills no defaults,
 * so the file, the published row, `campaign.json` and the run's stamp all hash
 * the same object. The store's write-once rule compares it; a run stamped with
 * it says which definition it followed.
 */
export function campaignHash(def: CampaignDefinition): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalJson(def)).digest("hex").slice(0, 16)}`;
}

/** The cell a definition declares under `cellId`, or undefined. */
export function cellOf(def: Pick<CampaignDefinition, "cells">, cellId: string | null): CampaignCell | undefined {
  return cellId === null ? undefined : def.cells.find((c) => c.id === cellId);
}

/** The arm a definition declares under `armId`, or undefined. */
export function armOf(def: Pick<CampaignDefinition, "arms">, armId: string | null): CampaignArm | undefined {
  return armId === null ? undefined : def.arms.find((a) => a.id === armId);
}

/**
 * Whether a run's recorded start differs from the start its cell declares —
 * the check that would have caught class-probe's `nightelf-hunter` cell, whose
 * first runs were Night Elf Rogues under a hunter's id. Only a reading both
 * sides recorded can disagree; a run with no race or class on record does not.
 */
export function startMismatch(
  cell: { race: number; class: number } | undefined,
  run: { race: number | null; class: number | null },
): boolean {
  if (cell === undefined) return false;
  return (run.race !== null && run.race !== cell.race) || (run.class !== null && run.class !== cell.class);
}

/**
 * The run dimensions a cell launches under. One function for both sides of a
 * launch: the runner fills a fresh probe's config from it, and the fleet plans
 * with the same numbers (the ceiling for ETAs and drains), so the two cannot
 * disagree about what a probe was given.
 */
export function cellDimensions(
  def: CampaignDefinition,
  cell: CampaignCell,
  /** A party member: its own start and objective stand in for the cell's and the definition's. */
  member?: PartyMember,
): {
  race: number;
  class: number;
  watchdogs: { idleMs: number; noXpMs: number | null; episodeMs: number };
  maxToolCalls: number;
  wikiCoords: boolean;
  wiki: boolean;
  objective?: string;
  stopAtLevel?: number;
} {
  const objective = member !== undefined ? member.objective : def.objective;
  return {
    race: member?.race ?? cell.race,
    class: member?.class ?? cell.class,
    watchdogs: { idleMs: def.budget.idleMs, noXpMs: def.budget.noXpMs, episodeMs: def.budget.episodeMs },
    maxToolCalls: def.budget.maxToolCalls,
    wikiCoords: def.wikiCoords,
    wiki: def.wiki,
    ...(objective !== null ? { objective } : {}),
    ...(def.stopAtLevel !== null ? { stopAtLevel: def.stopAtLevel } : {}),
  };
}

/** A zod error as one line per issue, with the path it was found at. */
export function issuesOf(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");
}
