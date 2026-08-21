The basics, in launch order:
- .gm on — enable GM mode (grants the untouchable/invulnerable state)
- .gm visible off — go invisible so you don't appear in the agent's observation packets. This is the important one for run hygiene: while invisible you're filtered out of what the model's session sees.
- .gm fly on — free flight in the world, no mount needed. This is the way to "fly" in old-world zones like Elwynn (where actual flying mounts are blocked by 3.3.5 client rules). Just jump and hold spacebar to ascend. .gm fly off to land normally.

Getting around:
- .appear <name> — teleport yourself to a player (e.g. .appear Oxfour). This is the spectating workhorse. Never use .summon <name> — that yanks the agent's character to you, which would wreck a live run.
- .go xyz <x> <y> <z> — teleport to exact coordinates (useful if you're reading positions out of a trajectory log)
- .tele <location> — teleport to a named location, e.g. .tele northshire, .tele stormwind. .lookup tele <part> searches the location list.
- .recall — return to where you were before your last teleport
- .modify speed <1-10> — faster run speed if you'd rather stay grounded (e.g. .modify speed 5)

Mount answer specifically: you can .additem yourself a flying mount, but in 3.3.5a the client refuses to let you take off in Eastern Kingdoms/Kalimdor zones (no flight there until Cataclysm), so it'd only work in Outland/Northrend. .gm fly on sidesteps all of that and works everywhere — it's strictly better for spectating.

Useful inspection extras:
- Target the agent's character (tab or click while invisible works) then .pinfo — account/level/money summary
- With a target: .character level info shows via .pinfo; .npc info on a creature dumps its entry/flags/faction — handy for checking what the model is fighting
- .gps — prints your current map/zone/coordinates (good for cross-referencing against trajectory positions)
- .whereis <name> isn't a real command — to find the agent, just .appear to them.

Etiquette reminders from the spectating notes: stay .gm visible off the whole time a measured run is live, never interact with the agent's target or loot, never .summon, and don't cast anything near its combat — GM auras and area effects can leak into its combat log events. Look, don't touch.

One honest caveat: I'm confident about the core commands above (they're standard AzerothCore/TrinityCore GM commands and match what's documented in infra/SPECTATOR.md), but exact syntax for the more obscure ones can vary by core version — .help <command> in-game lists arguments if one gives you trouble.

