# Night plan — 2026-08-22 → 23

Operator direction, 2026-08-22 evening. Persistent so a resumed session can pick
it up. Ladder and priorities: `docs/VISION.md`; work items: `docs/FOLLOW-UPS.md`
38 (navigation), 39 (spellbook / escape hatch), 35 (milestones), 22 (map replay).
Every item lands under the project rules: client-observable only
(`docs/CONTRACTS.md`), thin module, helpers earned by observed need (ADR-0015),
deterministic repairs only (ADR-0016), model-agnostic loop.

## Tonight, in order

1. **Gate window (~22:50, zero live runs).** `./infra/deploy-worldserver.sh`
   (first real use; promotes `:next` = `/health` build id, recreates with the
   `SMOKE` allowlist), then `stop fleet` / `up -d --no-deps fleet` so the
   supervisor runs the preflight-gate code, flip `preflight.enabled: true` and the
   four lanes on in `infra/fleet.json`. Verify `--status` shows a gate record with
   `server build harness-0.3-41-…`.
2. **00:00 UTC (10:00 local)** — re-enable `free-or-a` / `free-or-b` (OpenRouter
   daily cap reset).
3. **Verify today's fixes (c4 episodes, first on the full new stack).** Sonnet
   fan-out, same brief as the afternoon review, plus: do `closest()` errors,
   questgiver timeouts and blind grinding drop; are `questGiver` markers and
   `objectives` actually used; money/vendor — do models sell and buy spells with
   intent, and what signal is missing (rung 5 precursor). Harness findings →
   fixes through the same API-design rules; model-attributable findings → notes
   only.

## Tracks to start after the window

**Track A — Navigation, rungs 2–4 (FOLLOW-UPS 38). Fable, module work serialized.**
N1 first: `no_path` causes with the z-ladder retry inside the module, automatic
`CMSG_AREATRIGGER` within `move_to`, transfer taps, `moveTo` resolving on a
server-confirmed postcondition, typed transfer waits. Gate: the travel probe
rides the tram end to end with a typed success; then the navigation ADR. Then N2
(zone name, NPC roles, innkeeper bind, milestone records #35), N3 (flight
paths), N4 (scored rung-4 attempts). Each module increment ships via
`deploy-worldserver.sh` at a drain window.

**Track B — Spellbook, cooldowns, talents, raw-action passthrough (FOLLOW-UPS
39). Fable for the taps, Opus for SDK/docs.** Schedule its (small) module taps
before N1's larger module change; SDK/cache work in parallel. Includes the
CONTRACTS drift (trainers shipped; `whisper` never implemented). Rung 3 is
unverifiable without it.

**Track C — Release-point surface. Opus, dashboard; no module contact.** Pinned
episode budget stamped into run metadata, eval charts (turns-to-level per model
per harness version), map replay (#22), ladder page with reached rungs.

**Money (rung 5 precursor).** Selling and buying exist (`sellItem`, `buyItem`,
trainers). Tonight's analysis decides whether a money/vendor *signal* is earned;
no speculative helper.

## Decisions still open (operator)

- Wiki infobox coordinates in the scored lane (FOLLOW-UPS 38, open decision):
  recommendation is names-first for scored runs, labeled for freeplay. Needed
  before the first scored rung-4 run, not before N1–N3.
- Rung 6 / group tier (#40) waits on 38/39 and per-character credentials (#10).

## Standing rules for the night

- No worldserver restart with a live run; deploys only via `deploy-worldserver.sh`.
- Agents: explicit-path staging, new commits only (no `--amend`, no reset /
  checkout / stash). Module agents serialized.
- Nothing Blizzard-derived in git; bundle swaps are an `mv` of a side build.
