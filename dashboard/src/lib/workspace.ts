/**
 * The run page's workspace panel, the parts with no DOM in them.
 *
 * The listing arrives notes.md first and the rest by path — the viewer orders
 * it (`runner/viewer/runs.ts`), and the snapshot publishes that order — so the
 * panel renders it as given. What is decided here is which file is open, when
 * the open file has to be read again, and which files are code.
 */

import type { WorkspaceFileView } from "@viewer/api-types";

/** The one file the harness knows by name: the model's notes, open by default. */
export const NOTES_PATH = "notes.md";

/**
 * The file to show: the one picked while the listing still has it, else
 * notes.md, else the first file; undefined for an empty listing. A pick the
 * model has since deleted falls back rather than holding the panel on a file
 * that is gone.
 */
export function openFile(files: readonly WorkspaceFileView[], picked: string | undefined): WorkspaceFileView | undefined {
  return (
    (picked === undefined ? undefined : files.find((f) => f.path === picked)) ??
    files.find((f) => f.path === NOTES_PATH) ??
    files[0]
  );
}

/**
 * What identifies one reading of a file: its path, size and mtime. The open
 * file is read again only when this moves, so a live run's listing poll costs
 * one small request and not a re-read of the file every tick.
 */
export function fileReading(f: WorkspaceFileView): string {
  return `${f.path}\n${f.bytes}\n${f.mtime}`;
}

/** A TypeScript module — what a snippet imports — shown the way the page shows code. */
export function isCode(path: string): boolean {
  return path.endsWith(".ts");
}
