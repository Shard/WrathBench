/**
 * The seam between the roster and the party stager (docs/proposals/
 * GROUP-PLAY.md §3): what the roster asks for before a fresh party launch,
 * and what it is told back. The stager itself — deleting last attempt's
 * characters, creating the members, the scenario, the loadout over SOAP, the
 * pre-formed party — is `infra/fixtures/stage-party.ts`, built in its own
 * track; this module is the narrow interface both sides hold to, and the one
 * implementation the roster runs (`commandStager`), which spawns that script.
 *
 * The contract, for the staging track to match:
 *
 *   bun infra/fixtures/stage-party.ts --request -
 *
 * reads one `StageRequest` as JSON on stdin and exits 0 when every member is
 * staged — created on its account under its `character` name, the scenario
 * applied at its level, its loadout and talents in place, logged out in the
 * scenario's spot, and the party formed with the first member leading — or
 * non-zero when it is not, saying why on stderr. Its last stdout line may be
 * a JSON `{ "ok": true, "detail": "…", "members": [{ "member", "guid" }] }`:
 * the detail for the roster's log, and each member's character guid (decimal),
 * which the roster writes into every member's campaign file before any of
 * them launches, so each session record knows the others as the deployment's
 * own from its first row. Nothing else on stdout is read. It must leave no session open on any member's account:
 * the members' own runs log in next.
 *
 * Called only before a fresh party launch, never on a resume (the members'
 * characters are the paused runs' own) and never in a dry run.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PartyRole } from "../runner/src/party";

/** One member to stage, in member order. */
export interface StageMember {
  /** The member id (`tank`, `healer`, …), its run id's suffix. */
  member: string;
  role: PartyRole;
  /** The client's own race and class ids. */
  race: number;
  class: number;
  /** The name to create it under — the definition's, and the one its run is launched with. */
  character: string;
  /** The game account it lives on: one per member, never shared. */
  account: string;
  /** The member's run id, for the stager's log and nothing else. */
  runId: string;
}

/** What the roster asks the stager for. */
export interface StageRequest {
  /** The party id: the attempt's run-id stem. */
  party: string;
  /** The campaign and version the party is a square of. */
  campaign: string;
  version: number;
  /** The fixture scenario to apply (the definition's `start.staged`) and the level it stages. */
  scenario: string;
  level: number;
  /** Every member, in member order; the first leads the party. */
  members: StageMember[];
}

/** One staged member's character, as the stager reports it: the guid the session record writes. */
export interface StagedGuid {
  member: string;
  guid: string;
}

/** The stager's answer. A refusal's `reason` is the operator's whole notice, and lands on every member's launch-failed record. */
export type StageResult = { ok: true; detail?: string; members?: StagedGuid[] } | { ok: false; reason: string };

/** A decimal guid low part, as `partyMemberRecordSchema` takes one. */
const GUID_RE = /^[1-9][0-9]{0,9}$/;

/** The members a stager's last line reports, keeping only well-formed entries; undefined when it reports none. */
export function stagedGuidsOf(v: unknown): StagedGuid[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: StagedGuid[] = [];
  for (const e of v as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const { member, guid } = e as { member?: unknown; guid?: unknown };
    if (typeof member === "string" && typeof guid === "string" && GUID_RE.test(guid)) out.push({ member, guid });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * What the roster holds of a stager. `signal` is the roster's stop: an
 * aborted staging ends at once (the script is killed), so a deploy window's
 * SIGTERM never leaves a stager sending commands to a worldserver being
 * replaced.
 */
export interface PartyStager {
  /**
   * `env` is laid over the stager's environment: an attempt on a world of its
   * own stages there (`stagingEnvOf` in infra/world.ts — its module, SOAP
   * console and characters schema), never on the shared world.
   */
  stage(req: StageRequest, signal?: AbortSignal, env?: Readonly<Record<string, string>>): Promise<StageResult>;
}

/** Where the stager lives, relative to the repository root. */
export const STAGER_SCRIPT = join("infra", "fixtures", "stage-party.ts");

/** How long a staging may take before it is a failure: five members, a few logins each, with room. */
export const STAGE_TIMEOUT_MS = 20 * 60_000;

/** The last line of a text, trimmed; "" when there is none. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").trim();
}

/**
 * The stager the roster runs: the script above, as a child, with the request
 * on stdin. A script that is not there yet is a refusal naming it, not a
 * crash, so a party campaign enabled before the staging track lands records
 * launch-failed attempts that say why.
 */
export function commandStager(opts: { cwd: string; script?: string; timeoutMs?: number; command?: readonly string[] }): PartyStager {
  const script = opts.script ?? STAGER_SCRIPT;
  return {
    async stage(req: StageRequest, signal?: AbortSignal, env?: Readonly<Record<string, string>>): Promise<StageResult> {
      if (signal?.aborted === true) return { ok: false, reason: "staging stopped before it began" };
      if (opts.command === undefined && !existsSync(join(opts.cwd, script))) {
        return { ok: false, reason: `the party stager ${script} is not installed in this image` };
      }
      const argv = [...(opts.command ?? ["bun", script]), "--request", "-"];
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(argv, { cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...(env !== undefined ? { env: { ...process.env, ...env } } : {}) });
      } catch (e) {
        return { ok: false, reason: `the party stager did not start: ${e instanceof Error ? e.message : String(e)}` };
      }
      const timeoutMs = opts.timeoutMs ?? STAGE_TIMEOUT_MS;
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      let aborted = false;
      const abort = (): void => {
        aborted = true;
        proc.kill("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const stdin = proc.stdin as import("bun").FileSink;
        stdin.write(JSON.stringify(req));
        await stdin.end();
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        if (aborted) return { ok: false, reason: "staging stopped: the roster was signalled" };
        if (code !== 0) {
          const why = lastLine(err) || lastLine(out) || `exit ${code}`;
          return { ok: false, reason: `staging failed (exit ${code}${proc.signalCode === "SIGKILL" ? `, killed after ${Math.round(timeoutMs / 60_000)}m` : ""}): ${why.slice(0, 500)}` };
        }
        try {
          const doc = JSON.parse(lastLine(out)) as { ok?: unknown; detail?: unknown; members?: unknown };
          const members = stagedGuidsOf(doc.members);
          return { ok: true, ...(typeof doc.detail === "string" ? { detail: doc.detail } : {}), ...(members !== undefined ? { members } : {}) };
        } catch {
          return { ok: true };
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
