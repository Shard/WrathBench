# ADR-0001: Game and server

Status: Accepted. Date: 2026-08-21.

## Context
We want an LLM evaluation built on a classic, popular game with non-obvious decisions, an open engine, and no established harness. Candidates considered across several rounds: Papers, Please (contaminated; the difficulty is the answer itself), OpenXcom (strong, turn-based, unclaimed), Warcraft III (no open engine, real-time, reads as StarCraft II with heroes), World of Warcraft 3.3.5a on AzerothCore.

## Decision
World of Warcraft 3.3.5a on AzerothCore.

## Alternatives
- OpenXcom: cleaner experiment, smaller. Kept as a possible sibling project.
- TrinityCore 3.3.5: fallback if AzerothCore's module system proves limiting.
- CMaNGOS: pins 12340 tightly but no first-party containers.

## Consequences
- Richest decision space of the candidates and a path to coordination tasks.
- Real-time game; the clock problem is addressed by the agent model (ADR-0003) rather than by pausing.
- Legal posture must be explicit (see DATA-AND-LEGAL.md).
- No faster-than-realtime mode exists; episode cost is linear in wall-clock.
