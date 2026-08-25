# ADR-0050: The model names its character

Status: Accepted. Date: 2026-08-25. Consequence of ADR-0049; changes what the
runner tells the model at launch, and what the scheduler prefers when it hands
out an account. Race and class are untouched: they remain the episode's fixed
dimensions (ADR-0033) and no model chooses them.

## Context

Every roster entry carried a fixed character name — `Fleetsonnet`, `Hyfree`,
`Qwenlocal` — and the runner assigned it. That worked while ADR-0036 sent a
lapsed run back to the account it paused on: the name lived on one account and
episode hygiene, which clears the launching account and nothing else, always saw
it.

ADR-0049 ended that. A scored run that lapses is a *failed attempt* and the
model gets a fresh one, scheduled onto whichever pool account happens to be
free. On 2026-08-25 at 01:01 the fresh attempt
`fleet-sonnet-e90-sonnet-20260825-a12` landed on RUNNER3 while `Fleetsonnet`,
from the ended `a10` run, was still standing on RUNNER5. Hygiene cleared RUNNER3
— which was already clear — and the model then spent eight minutes looping
`char_create_failed_code_50 (name already in use)` with no character in the
world at all. The attempt was SIGTERMed by hand.

Three separate things were wrong, and only one of them is scheduling.

- The name is global (a realm-wide unique) and hygiene is per-account. A fixed
  per-model name is therefore a resource shared across accounts with nothing
  arbitrating it.
- The error told the model a fact and no way forward. `code 50` rendered as
  "that name is already in use", full stop — so the model retried the only name
  it had been given, forever. `Fleetsonnetlo` (13 letters, refused by the
  runner's own name rule) had respawn-looped the same way for two hours on
  2026-08-24: the harness had twice handed a model a name it could not use and
  no way to pick another.
- Nothing about the name is a measurement. The comparability tuple does not
  carry it (`comparability.ts` has no `character`), the ladder does not read it,
  and no chart groups on it.

## Decision

**The model names its own character, on every fresh launch.** The launch
session note invites it: 2-12 letters, no spaces, no three identical letters in
a row — the game's own rule, the same predicate `isValidCharacterName` enforces
at every other boundary — and says the name is the model's for the episode. The
roster's `character` stays, as the suggestion the note offers to a model that
would rather not choose. `CreateSessionRequest.character` is required by the
SDK, so the note makes the model supply one rather than the runner defaulting it
into a call the model itself makes.

Race and class are stated in the same note as *not* the model's to choose, and
why: they are the episode's dimensions and every run is read against them.

The resume note is unchanged, deliberately, down to "do not create a different
one": a resumed run keeps the character it left standing, by name.

**Code 50 becomes a retry, not a dead end.** The SDK's char-create hint for
`0x32` now says to choose a different name and call `createSession` again, in
the naming rule. Deterministic, model-agnostic, and the same shape as every
other entry in that table — it is what a real client's UI would tell a player.

**The recorded character is the one in the world.** At the first sight of a
character, the runner writes the observed name to the run row, to `meta.json`,
and as a `character` record in the trajectory. Three places because three
readers: the runs page and the positions feed read `run.character`, and a
resumed runner reads `meta.json` before any database is open. `accountHeldBy`
never read a character at all and is untouched.

**Scheduling gains account affinity.** A fresh attempt prefers the free account
the model's last run used — where its character, whatever it called it, is still
standing. A preference only: an affine account that is busy is not waited for.
This is what makes a repeated name harmless, because a model that liked
`Grimjaw` last time and picks it again finds hygiene has just wiped it on the
way in.

**Cross-account name hygiene is the fallback.** When a fresh launch goes
somewhere else and the old account is free, the supervisor deletes the stale
name there, through the module's client delete path — the same
`POST /character-delete` episode hygiene uses, never a database write
(CONTRACTS.md). It is planned only for an account this same tick considers free
(nothing holds it, nothing was assigned it), which makes the delete exactly as
safe as handing that account to a fresh run whose hygiene would wipe it anyway.
The launching account is excluded: its own hygiene owns it.

## Consequences

**A name can still collide, and that is now survivable.** Affinity makes it
rare, the sweep makes it rarer, and the error text makes the remaining case a
turn rather than an episode. No fail-fast termination was added: a run the model
can route around must not be ended for it.

**ADR-0006 still holds, and the proof is the guid.** `createSession` *reuses* an
existing character of the name it is given, so a model free to choose could
name a leftover the account's hygiene failed to delete and land on a used
character. The belt for that is unchanged and does not read names:
`expectFreshCharacter` arms on every guid hygiene *listed*, and the first
in-world observation fails on a listed guid or on any level above 1. The
braces are new — the note names the survivors and tells the model not to use
them.

**The launch note is harness surface.** What the model is told changed, so runs
either side of this are not strictly comparable and it warrants a harness minor
under the series rule. The version stamp is `git describe`, so that is a tag and
a `fleet.json` schedule decision, not a code change; it is not taken here.

**Why the model, and not a generated unique name.** A per-attempt suffix would
have solved the collision too. It was not chosen: 12 letters is the ceiling and
the roster's names are already at it — `Fleetsonnetlo` was 13 and looped — and
more to the point a name a model chose is one it may feel some ownership of. The
benchmark drives a character in a live world for hours; letting the thing being
driven be named by the thing driving it costs nothing measured and is the more
honest shape.
