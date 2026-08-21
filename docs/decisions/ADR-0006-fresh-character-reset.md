# ADR-0006: Fresh character reset for Phase 0

Status: Accepted. Date: 2026-08-21.

## Context
Character snapshot and restore via the database is feasible but has pitfalls (offline writes only, item GUID management, relogin). Phase 0 needs a reset, not a snapshot system.

## Decision
Every Phase 0 episode starts with a freshly created level 1 character in its starting zone. Character creation is a client action the module already supports.

## Alternatives
- DB snapshots: needed for mid-level starts and level bands. Deferred until a task needs them.
- GM-level commands to jump a character to a level: violates the action contract and skips the gearing and quest state a real character at that level has.

## Consequences
- Simplest possible reset; starting zones are the best-tested content in the emulator.
- Open-ended runs from level 1 are the Phase 0 task; the furthest level reached is the progress metric.
