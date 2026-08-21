# Vision

## What this measures
How well a language model drives a fixed toolkit to achieve long-horizon goals in a live game world.

The model is given a TypeScript SDK, a sandboxed runtime, a searchable reference bundle, and a character in World of Warcraft 3.3.5a. It writes snippets, sets up routines, watches events, and intervenes. The world does not pause for it. The server records what actually happened.

This is the same shape as RuneBench (RuneScape), SWE-bench, and Terminal-Bench: model plus a fixed agent loop plus tools. It is not a direct-play benchmark. We say so up front.

## Why this game
- A mature open server (AzerothCore) with a headless mode, a modular C++ extension system, and a human-readable database for state and content.
- A decision space that is richer than skill grinding: quests, travel, gear, rotations, death recovery, and later group roles and encounter mechanics.
- Knowledge of the game does not collapse the task. The wiki is in every model's training data and the task is still hard, because the bottleneck is execution in a stateful world, not recall.
- Room to grow into coordination tasks (dungeons) that almost nothing else benchmarks well.

## Why this design

- Script and supervise, not act per tick. A global cooldown rotation is something a person decides once and executes on autopilot. Putting the model at the routine and supervision layer tests the interesting decisions and makes latency a property of responsiveness to events, not a tax on every action.
- Fixed harness, model as the only variable. The SDK surface, agent loop, prompt, and reference bundle are frozen per harness version. A score is "harness vX, model Y, task Z". SDK changes are major versions and old scores keep their label.
- Server-side control module with a client-fidelity contract. Actions are dispatched through the same opcode handlers a real client uses; observations are limited to what a real client could see. This gives client fidelity without writing a packet client, and it is documented so the privilege question is answered before it is asked.

## What "good" looks like for Phase 0

A harness any model can plug into. Small capable models achieve liftoff: they create a character, read the quest log, complete quests, and gain levels. Frontier models go a long way with no harness errors in their trajectories. A frontier model hitting harness errors means the harness is wrong, not the model.

The dev loop is: point a model at it, let it run as far as it can, read where it stalled, fix the harness, repeat. The level the best model reaches before stalling is a progress metric for the harness as much as for the model.

## What this is not
- Not a composite score. Per-task tables with seeds and intervals.
- Not a leaderboard for arbitrary scaffolds. A bring-your-own-agent track, if it ever exists, is a separate board.
- Not a claim about retail WoW. It runs on the community reconstruction of 3.3.5a, pinned and deterministic in content, and compares models against each other in that world.
- Not a public play service. No endpoint anyone can point a client at, no recruited players, no money.
- Not a persistent multi-agent world. That is a later, separate artefact (the observatory) that reuses this infrastructure and produces logs and write-ups, never scores.

## Later tracks, in rough order

Wider level bands and mid-level starts via character snapshots. SDK tier experiments (primitive vs composed). Perturbed-twin tasks as a contamination gate. Single dungeon encounters with a scripted party. Multi-agent dungeons. Gearing tasks scored by simulated DPS. The observatory.

None of these start until the Phase 0 gate is passed and the dev loop is boring.
