# ADR-0015: The SDK surface is simple by default, flexible by escape hatch

Status: Accepted. Date: 2026-08-21.

## Context
The first measured runs put a number on ergonomics. Models that had only
`killTarget` did fine until they needed something it did not express (an HP
abort), then hand-rolled a poll loop that raced the helper and got the character
killed. The model that stumbled onto background routines tripled its kill rate —
capability that was always there, just not discoverable. A surface too small
forces fragile snippet code; one too large burns turns on discovery (whole turns
spent introspecting `sdk`) and becomes permanent maintenance under ADR-0004.

## Decision
Two tiers, deliberately unequal. The **primary tier** is small: one obvious
helper per common want (move, fight, loot, quest, say) whose default is the
whole common case, with options only where runs proved models otherwise
reinvent it badly. Growth here is earned by observed need in trajectories,
never speculative, because everything here is permanent surface. The **escape
hatch** — raw actions, the event stream, the state cache — stays public and
supported; an agent composes these in the sandbox, and the SDK's job is to keep
that composition safe (helpers tolerate raw calls around them) rather than to
pre-package every strategy. **There is no middle tier** of convenience variants
(`killNearest`, `grindUntilLevel`); a composition every model writes graduates
to the primary tier, until then it lives in snippets.

Rejected: a flat maximal API (discovery cost grows linearly, mistakes are
pinned); raw actions only (the benchmark would measure boilerplate skill);
per-model surfaces (forbidden outright).

## Consequences
- The review question for any new helper or option: "which trajectory showed
  models needing this?" — with a run id, not a hunch.
- Surface area is a tracked cost; the prompt documents both tiers briefly so
  neither is luck to find.
- Raw actions and events get the same stability guarantees as helpers. ADR-0025
  widens the hatch to allowlisted raw opcodes.
