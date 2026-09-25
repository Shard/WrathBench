/**
 * The workspace: one directory per run, `data/runs/<id>/workspace/`, holding
 * the model's own files. `notes.md` is its memory and is shown in full every
 * turn; every other file is listed with its size and first line, read on
 * demand, and importable from a snippet as a TypeScript module.
 *
 * Only the runner process writes here. The snippet child reads the directory
 * (its Landlock ruleset admits it read-only, `sandbox/confine.ts`) so imports
 * resolve, and every write it wants goes over the IPC hostcall the host
 * answers from this class — the same rules and limits as the file tools, in
 * one place.
 *
 * Paths are relative to the workspace and normalised; `..`, absolute paths and
 * anything that would land outside the directory are refused with the path
 * named. The root directory is created once and never removed or replaced:
 * the child's read grant is bound to that inode, so a run that needs a clean
 * workspace empties it in place (`clear`).
 *
 * Limits are refusals, never truncation: a write whose result would exceed a
 * file's limit or the workspace total is refused with the size it would have
 * had, the limit and a target, and nothing is written. A write that lands
 * above 80% of a limit succeeds with a one-line warning, and every successful
 * write or edit ends with a usage line, so the model sees the room it has left
 * before it runs out rather than after.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";

/** The one file the harness knows by name: the model's memory, injected every turn. */
export const NOTES_PATH = "notes.md";
/** notes.md's limit, in characters. The old scratchpad's cap, unchanged. */
export const NOTES_MAX_CHARS = 32_000;
/** Every other file's limit, in characters. */
export const FILE_MAX_CHARS = 32_000;
/** The whole workspace's limit, in UTF-8 bytes on disk. */
export const WORKSPACE_MAX_BYTES = 1_048_576;
/** A write that lands above this fraction of a limit carries a warning. */
export const WORKSPACE_WARN_FRACTION = 0.8;
/** Above this fraction of the total, the usage line also states the workspace total. */
export const WORKSPACE_TOTAL_SHOWN_FRACTION = 0.5;
/** How much of a file's first line the listing shows. */
export const LISTING_FIRST_LINE_CHARS = 120;

/**
 * The file kinds a snippet may import (sandbox/rewrite.ts refuses the rest), and
 * so the only files whose change bumps the import version. One list for both,
 * because an importable file whose edit did not bump the version would be
 * served stale from the module cache.
 */
export const IMPORTABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

/** Whether a workspace path names a file a snippet can import. */
export function isImportable(path: string): boolean {
  return IMPORTABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** One file as the listing shows it. */
export interface WorkspaceEntry {
  /** Relative to the workspace, `/`-separated. */
  path: string;
  bytes: number;
  /** The file's first line, trimmed and capped at LISTING_FIRST_LINE_CHARS. */
  firstLine: string;
}

/** What the context shows of the workspace: pure data, rendered by `renderWorkspaceContext`. */
export interface WorkspaceView {
  files: readonly WorkspaceEntry[];
  notes: string;
}

export type WorkspaceResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * The names a refusal points at. The tools and the snippet-side `files`
 * object share every rule and every sentence; only what the model would call
 * to fix the problem differs.
 */
export interface WorkspaceVocabulary {
  write: string;
  read: string;
  replaceAll: string;
}

export const TOOL_VOCABULARY: WorkspaceVocabulary = {
  write: "write_file",
  read: "read_file",
  replaceAll: "replace_all: true",
};

export const SNIPPET_VOCABULARY: WorkspaceVocabulary = {
  write: "files.write",
  read: "files.read",
  replaceAll: "replace_all = true",
};

type ResolvedPath = { ok: true; rel: string; abs: string } | { ok: false; error: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Percent of a limit, floored, so a file shows 100% only when it is exactly at it. */
function pct(n: number, limit: number): number {
  return Math.floor((100 * n) / limit);
}

/** The per-file limit, in characters. */
export function fileLimit(rel: string): number {
  return rel === NOTES_PATH ? NOTES_MAX_CHARS : FILE_MAX_CHARS;
}

/** A first line as the listing shows it: trimmed, and capped with a visible cut. */
export function listingFirstLine(text: string): string {
  const nl = text.indexOf("\n");
  const line = (nl === -1 ? text : text.slice(0, nl)).trim();
  return line.length > LISTING_FIRST_LINE_CHARS ? `${line.slice(0, LISTING_FIRST_LINE_CHARS - 1)}…` : line;
}

/** The fixed first line of the listing block. */
export const WORKSPACE_LISTING_HEADER = "files in your workspace, sorted by path (path, size, first line):";

/**
 * The listing block. Pure: the entries arrive as data, already sorted by
 * `Workspace.list`, and the same entries always render the same bytes.
 */
export function renderWorkspaceListing(files: readonly WorkspaceEntry[]): string {
  const lines = files.map((f) =>
    f.firstLine.length === 0 ? `${f.path}  ${f.bytes} bytes` : `${f.path}  ${f.bytes} bytes  ${f.firstLine}`,
  );
  return `<workspace>\n${WORKSPACE_LISTING_HEADER}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}</workspace>`;
}

/** notes.md verbatim, tagged with its path and how much of its limit it uses. Pure. */
export function renderNotes(notes: string): string {
  const usage = `${pct(notes.length, NOTES_MAX_CHARS)}% ${notes.length}/${NOTES_MAX_CHARS}`;
  const body = notes.length === 0 || notes.endsWith("\n") ? notes : `${notes}\n`;
  return `<notes path="${NOTES_PATH}" usage="${usage}">\n${body}</notes>`;
}

/** The listing, then the notes: what the context carries of the workspace. Pure. */
export function renderWorkspaceContext(view: WorkspaceView): string {
  return `${renderWorkspaceListing(view.files)}\n\n${renderNotes(view.notes)}`;
}

/** The `[x% — n/limit chars]` line every successful write or edit ends with. */
function usageLine(rel: string, chars: number, total: number): string {
  const limit = fileLimit(rel);
  const file = `${pct(chars, limit)}% — ${chars}/${limit} chars`;
  const whole =
    total > WORKSPACE_TOTAL_SHOWN_FRACTION * WORKSPACE_MAX_BYTES
      ? `; workspace ${pct(total, WORKSPACE_MAX_BYTES)}% — ${total}/${WORKSPACE_MAX_BYTES} bytes`
      : "";
  return `[${file}${whole}]`;
}

/** Every file under a workspace directory, sorted by path. Reads only. */
export function listWorkspace(dir: string): WorkspaceEntry[] {
  const out: WorkspaceEntry[] = [];
  const walk = (absDir: string, relDir: string): void => {
    for (const d of readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir.length === 0 ? d.name : `${relDir}/${d.name}`;
      const abs = join(absDir, d.name);
      if (d.isDirectory()) walk(abs, rel);
      else if (d.isFile()) {
        out.push({ path: rel, bytes: statSync(abs).size, firstLine: listingFirstLine(readFileSync(abs, "utf8")) });
      }
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** notes.md's text, or "" when it is absent. Reads only. */
export function readNotesAt(dir: string): string {
  const p = join(dir, NOTES_PATH);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** The listing and the notes of a workspace directory. Reads only. */
export function readWorkspaceView(dir: string): WorkspaceView {
  return { files: listWorkspace(dir), notes: readNotesAt(dir) };
}

/** The legacy scratchpad's own truncation marker, which a migrated pad must not carry into notes.md. */
const LEGACY_TRUNCATION_MARKER = /\n\n\[scratchpad truncated at \d+ chars\]$/;

export class Workspace {
  readonly dir: string;
  private importChanges = 0;
  private readonly listeners = new Set<(version: number) => void>();

  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
    const notes = join(this.dir, NOTES_PATH);
    if (!existsSync(notes)) writeFileSync(notes, "", "utf8");
  }

  /**
   * The import version: bumped by a write, edit or delete of an importable
   * file (`isImportable`), and by anything that replaces the workspace's
   * contents wholesale. Editing notes.md or any other text leaves it alone,
   * because every bump makes the next snippet import load a whole new module
   * graph, and the old one is never freed.
   */
  get importVersion(): number {
    return this.importChanges;
  }

  /** Called with the new import version after every bump; returns the unsubscribe. */
  onImportVersion(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A change to `rel` (or to the whole workspace, when absent): bump if anything importable moved. */
  private changed(rel?: string): void {
    if (rel !== undefined && !isImportable(rel)) return;
    this.importChanges++;
    for (const l of this.listeners) l(this.importChanges);
  }

  /**
   * A model-supplied path, checked and normalised. The refusals name the path
   * as given, because that is the text the model has to fix.
   */
  resolve(path: unknown): ResolvedPath {
    if (typeof path !== "string") return { ok: false, error: `path must be a string, got ${typeof path}` };
    const shown = JSON.stringify(path);
    if (path.length === 0) return { ok: false, error: "path is empty; name a file such as notes.md or lib/util.ts" };
    if (CONTROL_CHARS.test(path)) return { ok: false, error: `path ${shown} contains a control character` };
    if (path.includes("\\")) return { ok: false, error: `path ${shown} uses \\; the separator is /` };
    if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) {
      return { ok: false, error: `path ${shown} is absolute; paths are relative to the workspace, e.g. notes.md or lib/util.ts` };
    }
    if (path.split("/").includes("..")) {
      return { ok: false, error: `path ${shown} contains ..; paths stay inside the workspace` };
    }
    if (path.endsWith("/")) return { ok: false, error: `path ${shown} names a directory, not a file` };
    const rel = posix.normalize(path).replace(/^(\.\/)+/, "");
    if (rel === "." || rel.length === 0) return { ok: false, error: `path ${shown} names the workspace itself, not a file` };
    const abs = join(this.dir, ...rel.split("/"));
    if (!abs.startsWith(this.dir + sep)) return { ok: false, error: `path ${shown} resolves outside the workspace` };
    // Nothing but this class writes here and it never makes a link, so this is
    // belt and braces: the deepest part of the path that exists must really
    // be inside the workspace.
    let probe = abs;
    while (!existsSync(probe) && probe !== this.dir) probe = dirname(probe);
    try {
      const real = realpathSync(probe);
      const root = realpathSync(this.dir);
      if (real !== root && !real.startsWith(root + sep)) {
        return { ok: false, error: `path ${shown} resolves outside the workspace` };
      }
    } catch {
      return { ok: false, error: `path ${shown} could not be checked` };
    }
    return { ok: true, rel, abs };
  }

  /** Every file, sorted by path (code-unit order, so the listing is locale-free and stable). */
  list(): WorkspaceEntry[] {
    return listWorkspace(this.dir);
  }

  /** The listing and the notes, as the context shows them. */
  view(): WorkspaceView {
    return readWorkspaceView(this.dir);
  }

  readNotes(): string {
    return readNotesAt(this.dir);
  }

  /** UTF-8 bytes on disk across every file. */
  totalBytes(): number {
    return this.list().reduce((n, f) => n + f.bytes, 0);
  }

  read(path: unknown, vocab: WorkspaceVocabulary = TOOL_VOCABULARY): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (!existsSync(r.abs)) return { ok: false, error: `no such file in the workspace: ${r.rel}` };
    if (statSync(r.abs).isDirectory()) return { ok: false, error: `${r.rel} is a directory; ${vocab.read} reads one file` };
    return { ok: true, text: readFileSync(r.abs, "utf8") };
  }

  /** Create a file or replace its whole content. */
  write(path: unknown, content: unknown): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (typeof content !== "string") return { ok: false, error: `content must be a string, got ${typeof content}` };
    const blocked = this.blockedByFile(r.rel);
    if (blocked !== undefined) return { ok: false, error: blocked };
    if (existsSync(r.abs) && statSync(r.abs).isDirectory()) {
      return { ok: false, error: `${r.rel} is a directory, not a file` };
    }
    const created = !existsSync(r.abs);
    return this.commit(r.rel, r.abs, content, `${created ? "created" : "wrote"} ${r.rel}`);
  }

  /**
   * Replace an exact substring, the way an editing tool does. Refusals are the
   * point: an absent or ambiguous `old` means the model's picture of the file
   * and the file have diverged, and guessing which of two matches was meant is
   * referent selection the harness never makes (docs/METHODOLOGY.md, "The model
   * surface"). Plain string operations only — `old`/`new` are model text, so a
   * RegExp would choke on metacharacters and String.replace would read `$&`.
   */
  edit(
    path: unknown,
    oldString: unknown,
    newString: unknown,
    replaceAll: unknown = false,
    vocab: WorkspaceVocabulary = TOOL_VOCABULARY,
  ): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (typeof oldString !== "string") return { ok: false, error: `old_string must be a string, got ${typeof oldString}` };
    if (typeof newString !== "string") return { ok: false, error: `new_string must be a string, got ${typeof newString}` };
    if (typeof replaceAll !== "boolean") {
      return { ok: false, error: `replace_all must be true or false, got ${typeof replaceAll}` };
    }
    if (!existsSync(r.abs)) return { ok: false, error: `${r.rel} does not exist; create it with ${vocab.write}` };
    if (statSync(r.abs).isDirectory()) return { ok: false, error: `${r.rel} is a directory, not a file` };
    if (oldString.length === 0) {
      return { ok: false, error: `old_string is empty, so there is nothing to match; to replace a whole file use ${vocab.write}` };
    }
    if (oldString === newString) {
      return { ok: false, error: "old_string and new_string are identical, so this edit would change nothing" };
    }
    const current = readFileSync(r.abs, "utf8");
    const at: number[] = [];
    for (let i = current.indexOf(oldString); i !== -1; i = current.indexOf(oldString, i + oldString.length)) at.push(i);
    if (at.length === 0) {
      const where =
        r.rel === NOTES_PATH
          ? "notes.md as last written is in this turn's context"
          : `${vocab.read} shows the file as it is now`;
      return {
        ok: false,
        error: `old_string was not found in ${r.rel}; it must match exactly, including whitespace and line breaks (${where})`,
      };
    }
    if (at.length > 1 && !replaceAll) {
      const lines = at.map((i) => current.slice(0, i).split("\n").length);
      return {
        ok: false,
        error:
          `old_string occurs ${at.length} times in ${r.rel}, at lines ${lines.join(", ")}; ` +
          `include more surrounding text so it matches exactly once, or pass ${vocab.replaceAll}`,
      };
    }
    const next = replaceAll
      ? current.split(oldString).join(newString)
      : current.slice(0, at[0]!) + newString + current.slice(at[0]! + oldString.length);
    const n = replaceAll ? at.length : 1;
    return this.commit(r.rel, r.abs, next, `edited ${r.rel} (${n} replacement${n === 1 ? "" : "s"})`);
  }

  delete(path: unknown, vocab: WorkspaceVocabulary = TOOL_VOCABULARY): WorkspaceResult {
    const r = this.resolve(path);
    if (!r.ok) return r;
    if (r.rel === NOTES_PATH) {
      return { ok: false, error: `notes.md cannot be deleted; empty it with ${vocab.write} instead` };
    }
    if (!existsSync(r.abs)) return { ok: false, error: `no such file in the workspace: ${r.rel}` };
    const st = lstatSync(r.abs);
    if (st.isDirectory()) return { ok: false, error: `${r.rel} is a directory; delete the files in it one by one` };
    unlinkSync(r.abs);
    // Prune directories the delete left empty, never the root itself.
    for (let d = dirname(r.abs); d !== this.dir && d.startsWith(this.dir + sep); d = dirname(d)) {
      if (readdirSync(d).length > 0) break;
      rmdirSync(d);
    }
    this.changed(r.rel);
    return { ok: true, text: `deleted ${r.rel} (${st.size} bytes)` };
  }

  /**
   * Empty the workspace in place and start notes.md over. The root survives:
   * the snippet child's read grant is bound to it.
   */
  clear(): void {
    for (const name of readdirSync(this.dir)) rmSync(join(this.dir, name), { recursive: true, force: true });
    writeFileSync(join(this.dir, NOTES_PATH), "", "utf8");
    this.changed();
  }

  /** Copy another workspace directory's contents into this one, in place. */
  copyFrom(dir: string): void {
    for (const name of readdirSync(dir)) {
      cpSync(join(dir, name), join(this.dir, name), { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    this.changed();
  }

  /** Seed notes.md from a pre-workspace run's scratchpad, without its old truncation marker. */
  seedNotesFromScratchpad(scratchpadPath: string): void {
    const text = readFileSync(scratchpadPath, "utf8").replace(LEGACY_TRUNCATION_MARKER, "");
    writeFileSync(join(this.dir, NOTES_PATH), text, "utf8");
    this.changed(NOTES_PATH);
  }

  /** A parent component that exists as a file, which would make the path impossible. */
  private blockedByFile(rel: string): string | undefined {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const abs = join(this.dir, ...parts.slice(0, i));
      if (existsSync(abs) && !statSync(abs).isDirectory()) {
        return `${prefix} is a file, so ${rel} cannot be created under it`;
      }
    }
    return undefined;
  }

  /** The limit checks shared by write and edit, then the write itself. */
  private commit(rel: string, abs: string, content: string, head: string): WorkspaceResult {
    const limit = fileLimit(rel);
    if (content.length > limit) {
      return {
        ok: false,
        error:
          `${rel} would be ${content.length} chars, over its ${limit}-char limit; ` +
          `trim to under ${limit} chars or move detail to another file. Nothing was written.`,
      };
    }
    const bytes = Buffer.byteLength(content, "utf8");
    const before = existsSync(abs) ? statSync(abs).size : 0;
    const total = this.totalBytes() - before + bytes;
    if (total > WORKSPACE_MAX_BYTES) {
      return {
        ok: false,
        error:
          `the workspace would total ${total} bytes, over its ${WORKSPACE_MAX_BYTES}-byte limit; ` +
          `trim or delete files to get under ${WORKSPACE_MAX_BYTES} bytes. Nothing was written.`,
      };
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    this.changed(rel);
    const lines = [head];
    if (content.length > WORKSPACE_WARN_FRACTION * limit) {
      lines.push(`warning: ${rel} is ${content.length}/${limit} chars (${pct(content.length, limit)}% of its limit); a write past the limit is refused`);
    }
    if (total > WORKSPACE_WARN_FRACTION * WORKSPACE_MAX_BYTES) {
      lines.push(
        `warning: the workspace is ${total}/${WORKSPACE_MAX_BYTES} bytes (${pct(total, WORKSPACE_MAX_BYTES)}% of its limit); a write past the limit is refused`,
      );
    }
    lines.push(usageLine(rel, content.length, total));
    return { ok: true, text: lines.join("\n") };
  }
}

/**
 * The run's workspace, opened. A run that predates the workspace has a
 * `scratchpad.md` and no `workspace/`: its notes.md is seeded from the pad the
 * first time the run is opened (a resume onto the new harness), and the pad
 * itself is left where it was.
 */
export function openRunWorkspace(runDir: string): Workspace {
  const dir = join(runDir, "workspace");
  const legacy = join(runDir, "scratchpad.md");
  const fresh = !existsSync(dir);
  const ws = new Workspace(dir);
  if (fresh && existsSync(legacy)) ws.seedNotesFromScratchpad(legacy);
  return ws;
}

/**
 * Carry a predecessor run's workspace into a continuation: its whole
 * workspace when it had one, else its scratchpad as notes.md. Returns whether
 * anything was carried.
 */
export function carryWorkspace(ws: Workspace, predecessorDir: string): boolean {
  const dir = join(predecessorDir, "workspace");
  if (existsSync(dir)) {
    ws.copyFrom(dir);
    return true;
  }
  const legacy = join(predecessorDir, "scratchpad.md");
  if (existsSync(legacy)) {
    ws.seedNotesFromScratchpad(legacy);
    return true;
  }
  return false;
}

/**
 * The claude-code driver's SessionStart hook (matcher `compact`): after the
 * CLI compacts its own conversation, the workspace listing and notes.md are
 * printed to stdout, which the CLI adds to the model's context — the same
 * block the turn's context message carries. Reads the directory as it is at
 * that moment; writes nothing.
 */
if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined || !existsSync(dir)) {
    console.error("usage: bun workspace.ts <workspace-dir>");
    process.exit(64);
  }
  process.stdout.write(`${renderWorkspaceContext(readWorkspaceView(dir))}\n`);
}
