# ADR-0015: The SDK surface is simple by default, flexible by escape hatch

Status: Accepted. Date: 2026-08-21.

## Context
The first measured runs put a number on API ergonomics. Models that fought
through `killTarget` alone did fine until they needed something the helper
didn't express (an HP abort); every one of them then hand-rolled a poll loop
that raced the helper and got the character killed. Meanwhile the model that
stumbled onto background routines tripled its kill rate — capability that was
always there, just not discoverable. The lesson cuts both ways: a surface too
small forces fragile snippet code; a surface too large burns turns on
discovery (models spent whole turns introspecting `sdk` with
`Object.getOwnPropertyNames`) and grows a maintenance area that ADR-0004's
fixed-harness rule makes expensive to change later.

## Decision
Two tiers, deliberately unequal in size.

The **primary tier** is small: for each thing an agent commonly wants —
move, fight, loot, quest, say — there is one obvious helper whose default
behavior is the whole common case, expressed as options only where the runs
proved models otherwise reinvent it badly (`abortBelowHealthPct`, not a
callback protocol). Growth into this tier is earned by observed need in
trajectories, never speculative, and the bar is high because everything here
is permanent surface under ADR-0004.

The **escape hatch** is the tier below, which already exists and stays
public: raw actions (`attack_start`, `attack_stop`, `face`, `setTarget`),
the event stream, and the state cache. An agent that wants to flex its
coding skill composes these in the sandbox — background routines included —
and the SDK's job is to keep that composition safe (helpers must tolerate
raw calls happening around them, as the ATTACKSTOP re-arm does) rather than
to pre-package every strategy.

What we do not build is a middle tier of convenience variants
(`killNearest`, `grindUntilLevel`, …). If a composition proves so common
that every model writes it, it graduates into the primary tier; until then
it lives in snippets.

## Alternatives
- One flat maximal API: every capability a helper. Discovery cost grows
  linearly, maintenance is forever, and ADR-0004 means mistakes are pinned.
- One minimal API only (raw actions, no helpers): every model rebuilds
  movement and combat, badly, and the benchmark measures boilerplate skill
  rather than play.
- Per-model surfaces or prompt tuning: forbidden outright (CLAUDE.md, the
  loop is model-agnostic).

## Consequences
- API review question for any new helper or option: "which trajectory showed
  models needing this?" — with a run id, not a hunch.
- Total surface area is a cost we track, not just a capability list; the
  prompt documents both tiers briefly so neither is luck to find.
- The escape hatch is a supported contract, so raw actions and events get
  the same stability guarantees as helpers.
