# ADR-0045: The snippet timeout is a supervision cadence, not an execution limit

Date: 2026-08-24. Status: accepted (records a standing design; prompted by the
deepseek-flash L3 analysis, where the question "should its batch kill-loop
have been valid?" was asked twice in one evening).

## Context

Snippets are abandoned at `snippetTimeoutMs` (default 30s): the ambient signal
fires, pending SDK waits reject, the eventual result is discarded, and the
model is told — with the logs the snippet printed before dying. The game does
not pause for any of this; the world runs in real time regardless of what the
model is doing. So the timeout is not synchronising model execution with game
execution, and asking "why interrupt valid work?" is fair.

## Decision

The timeout bounds the SUPERVISION loop, not the work. Three reasons, layered:

1. **Liveness.** The model's only interface is submit → result → react. An
   unbounded await on something that never comes leaves it with no result and
   no decision point, in a world that keeps moving, until the 20-minute idle
   watchdog kills the whole episode — attributed to the model. The cap
   converts "stuck forever, run dies" into "one turn's lesson, run continues".
2. **Attribution.** Watchdogs read output cadence. A snippet that can block
   indefinitely is a blind spot where "model thinking", "model's code stuck"
   and "world broken" are indistinguishable — the same failure shape as an
   unbounded adapter retry loop (fixed the same day this was written: the
   retry loop got a wall-clock budget for the same reason).
3. **It is what makes supervision the measured thing.** The benchmark scores
   driving a toolkit — observe, decide, correct — not fire-and-forget
   scripting. The cap forces a decision point at least every 30s. Long work is
   not forbidden; it is required to be ASYNCHRONOUS: launch a background
   routine, return, supervise it from later snippets. That skill is the test.

The supporting pieces are sized to this: `killTarget` defaults to 25s so ONE
committed action fits a snippet; background routines ride AsyncLocalStorage so
they outlive their launching snippet (launch-and-return is immortal;
launch-and-block dies with the snippet, by design); an abandoned snippet's
partial console output is delivered, so a bounded snippet is never a total
loss for a model that streams its progress.

## Consequences

- An inline loop whose per-call timeouts sum past the cap can never finish
  (deepseek budgeted 12 x 25s into one snippet, four times, and lost only its
  un-streamed observations — the in-world kills persisted). This is scored as
  model behaviour, on purpose.
- The cap is uniform and model-agnostic. It is not tuned per model and never
  will be; a model that cannot work at a 30s cadence is exhibiting the deficit
  the benchmark exists to measure.
- Raising the default is an episode-comparability change (it alters the budget
  every scored run played under) and belongs with a harness minor bump.
