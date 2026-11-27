/**
 * Which kinds of moment a run's timeline marks, and as what
 * (`viewer/timeline-marks.ts` has the rule in full and re-exports
 * this). Here, import-free, because the camera's layout (`infra/camera/
 * layout.ts`) reads it as well as the viewer and the browser bundle, and the
 * viewer reads that layout: from `runner/src` each side takes it without one
 * tree importing back into the other.
 */

/** What a mark is of. */
export type MarkKind = "level" | "boss" | "death";
/** How it is drawn: a chapter divides the run, an event is a tick on it. */
export type MarkRole = "chapter" | "event";

const ROLES: Readonly<Record<MarkKind, MarkRole>> = { level: "chapter", boss: "chapter", death: "event" };

/** Every kind that is marked at all, chapters first. */
export const MARK_KINDS: readonly MarkKind[] = ["level", "boss", "death"];
/** The kinds that are chapters. */
export const CHAPTER_KINDS: readonly MarkKind[] = MARK_KINDS.filter((k) => ROLES[k] === "chapter");

/** A recorded type's role, or null for one that is not marked (`quest`, `zone`, anything unknown). */
export function markRole(type: string): MarkRole | null {
  return Object.hasOwn(ROLES, type) ? ROLES[type as MarkKind] : null;
}

export function isChapter(type: string): boolean {
  return markRole(type) === "chapter";
}
