# ADR-0007: Stock AzerothCore, no playerbots fork

Status: Accepted. Date: 2026-08-21.

## Context
mod-playerbots requires a fork of AzerothCore. It would provide a scripted party and a rough leveling reference, neither needed for single-character Phase 0. Its solo leveling is reported as flaky.

## Decision
Build against stock AzerothCore, pinned by commit. Defer the party question until encounter or multi-agent work begins.

## Alternatives
- Playerbots fork now: couples the module to two moving trees and a fork's merge cadence.
- NPCBots (trickstep): a module on stock AC, not a fork; a candidate when a party is needed.
- A party of our own scripted agents through the same module: cleanest long term, since baseline and measured agent share the contract.

## Consequences
- One dependency tree for Phase 0.
- The party decision is made with information from real runs rather than up front.
