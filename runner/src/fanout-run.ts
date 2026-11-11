/**
 * A fan-out run: one agent driving several characters (Shard/wrath-mcp#29,
 * phase 4). The mechanism is the stack's (`@wrathbench/mcp/fanout`: the
 * roster of seats, the tool list, the roll-up and the merged feed, each with
 * the stack's plain default wording); this file is what a run adds to it.
 *
 * - **The grant** is run configuration (`RunConfig.fanout`): how many
 *   characters and on which accounts. The agent holds one model credential
 *   and one conversation, and as many game accounts as it may have
 *   characters.
 * - **A record per character**, in the run directory: `sessions/<Character>/`
 *   where a single-character run has `session/`. Every character's kills feed
 *   the one drain the watchdogs read.
 * - **Where each character lives**, `roster.json` in the run directory, mode
 *   0600 because it holds each character's session token: what lets a resume
 *   bring back the characters that were in the world. The run's own
 *   `config.token` names no session at fan-out and is never leased.
 *
 * What a fan-out run means as a result (its episode, its comparability key,
 * its prompt and context rendering) is not decided here: it runs first as a
 * probe campaign (the operator's decisions of 2026-11-11), with the stack's
 * default wording.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CharacterRoster, type RosterEntry } from "@wrathbench/mcp/fanout";
import { moduleAuthHeaders, moduleIdentity } from "@wrathbench/mcp/module-auth";
import { newSessionToken, type FanoutConfig } from "./config";
import { openSessionRecord, type RecordSignals } from "./session-record";
import type { SandboxHost } from "./sandbox/host";

/** The file in a fan-out run's directory that keeps each character's account and token. Never served, copied or published. */
export const ROSTER_FILE = "roster.json";

/** The entries a run directory's roster file holds; none when it has no file or one that does not read. */
export function readRoster(runDir: string): RosterEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(runDir, ROSTER_FILE), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is RosterEntry => e !== null && typeof e === "object" && typeof (e as RosterEntry).character === "string" && typeof (e as RosterEntry).account === "string" && typeof (e as RosterEntry).token === "string")
      .map((e) => ({ character: e.character, account: e.account, token: e.token, in: e.in === true }));
  } catch {
    return [];
  }
}

/** Write the roster file whole, 0600, by rename. */
export function writeRoster(runDir: string, entries: readonly RosterEntry[]): void {
  const path = join(runDir, ROSTER_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * The characters a launch already knows: the ones a resumed run's roster
 * file holds, else the ones the operator staged, each given a token of its
 * own now. A staged character is not `in`: the agent logs it in by name.
 */
export function knownCharacters(fanout: FanoutConfig, stored: readonly RosterEntry[], newToken: () => string = newSessionToken): RosterEntry[] {
  if (stored.length > 0) return stored.map((e) => ({ ...e }));
  return (fanout.staged ?? []).map((s) => ({ character: s.character, account: s.account, token: newToken(), in: false }));
}

export interface OpenFanoutOptions {
  fanout: FanoutConfig;
  moduleUrl: string;
  runDir: string;
  runsDir: string;
  sandbox: SandboxHost;
  /** The run's secret registry and scrub: the trajectory. */
  secrets: { redact(secret: string | undefined): void; scrub(text: string): string };
  /** The one drain every character's record feeds (`RecordSignals`). */
  signals: RecordSignals;
  /** Where the port secret is read from; the process's own environment by default. */
  env?: Record<string, string | undefined>;
}

/**
 * The run's roster, on its sandbox: seats are leased from the run's accounts,
 * each character's record is opened in `sessions/<Character>/`, and the
 * roster file is rewritten on every change. Every seat token is registered
 * with the run's redactor as it is minted or read back, so no line of the
 * trajectory and nothing a model is served holds one; the roster file is
 * their one home, as `meta.json` is the single character's.
 */
export function openFanout(o: OpenFanoutOptions): CharacterRoster {
  const known = knownCharacters(o.fanout, readRoster(o.runDir));
  for (const e of known) o.secrets.redact(e.token);
  const module = moduleIdentity(o.moduleUrl, moduleAuthHeaders());
  const ownGuids = (o.fanout.staged ?? []).flatMap((s) => (s.guid !== undefined ? [s.guid] : []));
  const roster: CharacterRoster = new CharacterRoster({
    grant: { maxCharacters: o.fanout.characters, accounts: o.fanout.accounts },
    moduleUrl: o.moduleUrl,
    sandbox: o.sandbox,
    secrets: o.secrets,
    known,
    ...(o.env !== undefined ? { env: o.env } : {}),
    onChange: (entries) => writeRoster(o.runDir, entries),
    newToken: () => {
      const token = newSessionToken();
      o.secrets.redact(token);
      return token;
    },
    record: (seat) => {
      const { writer } = openSessionRecord({
        runDir: o.runDir,
        runsDir: o.runsDir,
        ownGuids,
        token: seat.token,
        scrub: (text) => roster.scrubTokens(o.secrets.scrub(text)),
        character: seat.character,
        signals: o.signals,
      });
      void module.then((m) => writer.setModule(m));
      return writer;
    },
  });
  // Staged characters are on the record from the launch, tokens and all.
  if (known.length > 0) writeRoster(o.runDir, roster.snapshot());
  o.sandbox.attachFanout(roster);
  return roster;
}

/**
 * The launch note a fan-out run starts with, in place of the
 * single-character one. Plain and neutral on purpose: it states the grant
 * and names the tools, and says nothing about how to play. The benchmark's
 * own wording for a fan-out run is decided with its harness round
 * (Shard/wrath-mcp#29, decision 8).
 */
export function fanoutSessionNote(o: { characters: number; staged: readonly string[]; resumed: boolean; back: readonly string[]; lost: readonly { character: string; error: string }[] }): string {
  const head = o.resumed
    ? "the runner process was restarted and this run resumed after a pause. Conversation history was not preserved; your scratchpad was. "
    : "";
  const grant = `This run may have up to ${o.characters} characters in the world at once. login_character logs one in by name, logout_character logs one out, and list_characters shows them; a character's name is what the \`character\` argument of run_snippet, recent_events and state_summary takes.`;
  const staged = !o.resumed && o.staged.length > 0 ? ` These characters already exist and are yours: ${o.staged.join(", ")}. Log each in by its name; do not create others in their place.` : "";
  const back = o.resumed && o.back.length > 0 ? ` These characters were in the world and have been logged back in: ${o.back.join(", ")}.` : "";
  const lost = o.lost.length > 0 ? ` These could not be logged back in: ${o.lost.map((l) => `${l.character} (${l.error})`).join("; ")}.` : "";
  return `${head}${grant}${staged}${back}${lost}`;
}
