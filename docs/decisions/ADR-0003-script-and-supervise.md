# ADR-0003: Script-and-supervise agent model

Status: Accepted. Date: 2026-08-21.

## Context
The game is real-time. Per-action model decisions would make latency dominate results and require pausing the world. WoW is also a game humans already play partly through macros and routines.

## Decision
The model writes TypeScript snippets against the SDK in a persistent per-session runtime, leaves routines running, receives events, and intervenes. This is the RuneBench pattern. Latency becomes responsiveness to events rather than a per-action tax.

## Alternatives
- Per-tick structured actions with a paused or time-banked world: cleaner reasoning measurement, but needs server pause support that does not exist and measures the wrong layer for this game.
- One large script the model maintains: brittle; short snippets against shared state are easier to supervise and log.

## Consequences
- The benchmark measures driving a toolkit, not direct play. Stated in VISION.md.
- SDK fluency is a confound; addressed by a fixed harness (ADR-0004) and, later, SDK tier experiments.
- Sandboxing the runtime is mandatory from day one.
