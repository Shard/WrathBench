# Group play: the Deadmines eval (ladder rung 6)

Status: design, investigated against the code at the commit this file lands
in. Nothing here is built. The decisions it rests on are the operator's; the
rest is the smallest shape of each change that the code admits, with the file
it lands in, and the smoke that proves it.

## The operator's decisions (2026-10-19)

- **A Deadmines eval.** One model runs a dungeon group of five characters as
  five agent loops of the same model: five runs, one character each,
  coordinating in game — party chat, whispers, what each one observes. Not one
  loop driving five clients.
- **It starts as a probe campaign** (unscored arms) and is promoted to a
  scored episode later, once the mechanics and the scoring settle. Scoring is
  not decided now.
- **Predefined loadouts.** Alliance, all level 20: a warrior tank, a priest
  healer and three DPS (mage, rogue, hunter), in quest-level green gear.
- **The model surface stays simple by default** (CLAUDE.md's hard
  constraints): the agent observes only what a client could, acts only
  through client opcode handlers, the C++ module stays thin, and there are no
  per-model prompts. A per-role goal line is harness text, the same for every
  model.

On the open questions of the first draft, the operator decided the same day
(2026-10-19):

- **SOAP is enabled for staging**, with an admin-level `STAGER` account,
  bound in-cluster only and used solely by the stager before a party
  launches. It must never be reachable from a sandbox or a run pod; §3 says
  how the NetworkPolicy and the sandbox's network guard keep it out of
  reach, and the places that said "SOAP is off by contract" now say what the
  contract actually binds.
- **The party is pre-formed at staging.**
- **Talents are preset per role.**

Everything below applies those. Where a step still needs a decision, it is
listed under "Open questions" and not taken here.

## The shape in one paragraph

A party is one fleet job that holds five accounts and runs five episodes at
once, started together, stopped together, and given one verdict. Each episode
is an ordinary run of this runner on a pre-staged character: five characters
created through the module, put into the loadout by the fixture tool and one
GM command over SOAP, grouped through the module, and logged out standing in
Moonbrook. Each loop is told its character, its party and its role in the
operator-objective block. The five walk down the mine to the instance portal,
which the module already crosses the way a client does, and the records that
say what happened — joined a party, entered map 36, killed Edwin VanCleef —
are three new milestone kinds read off packets the server sends anyway. The
campaign page tallies parties, not runs.

## 1. The party job

**What exists.** A job is one `run-roster` process on one account
(`infra/run-fleet.ts`, `spawnJob`: it writes the job's roster file, one
`RosterSpec` per entry, and spawns `infra/run-roster.ts`; `JobSpawn.account`
in `infra/run-fleet-config.ts`). The roster runs its specs one after another
(`run-roster.ts`, `main`: `for (const a of pending) … await attemptSpec(…)`),
each through `infra/episode-launcher.ts` as a child process or a run pod. A
probe campaign's square becomes such a job (`policyCampaignJobName` /
`pinnedCampaignJobName` in `runner/src/campaigns.ts`) and the campaign's
progress is a tally of runs per square (`campaignSquares`). Everything the
supervisor knows about a run it reads from the run directory
(`docs/ARCHITECTURE.md`, "Launching a run: the run contract").

**The smallest change: the roster gets a party mode.** One job, one roster
process, one log and one defer sidecar, five accounts and five concurrent
episodes. Nothing above the roster has to learn that an episode has siblings
beyond the account count, and nothing below it has to learn anything at all.

- `JobSpawn.accounts: string[]` beside `account` (the party's five, in member
  order); `RosterSpec.party = { id, member, role, size }` on each of the five
  entries the spawn materialises (`fillEntries` in `run-fleet.ts`). The party
  id is the job's run-id stem; member run ids are `<stem>-<member>`
  (`-tank`, `-healer`, `-mage`, `-rogue`, `-hunter`), so the five directories
  sort together and the stem alone names the attempt.
- **Shared start.** The roster launches the five `attemptSpec`s in one pass
  and awaits them together, instead of in sequence. Each gets its own
  account from the spawn, its own pod (run pods are on for probes, so five
  pods per attempt, each with its own `image.json`), and the same
  `--episode-ms` from the same instant.
- **Shared stop.** The roster's SIGTERM path stops the one episode handle it
  holds today (`requestStop` → `stop(graceMs)`); party mode keeps the five
  handles and stops them the same way. A drain, a fleet stop, a config edit
  that disables the job and a deploy window therefore pause all five at once,
  as they pause one today, through the signal they already send.
- **Shared fate.** The first member to leave the world ends or pauses the
  attempt for the other four. The roster watches the five `exited` promises;
  when one settles it reads that run's row (`readRunRow`) and stops the
  others with the episode grace:
  - a **termination** on one member (`idle`, `episode-limit`,
    `adapter-error`, `tool-call-limit`, `harness-error`, `launch-failed`, a
    pod eviction) → the other four are terminated `party-ended`, detail
    `<member>: <reason>` (a new `TerminationReason` in
    `runner/src/trajectory.ts`, written through the runner's own writer the
    way the supervisor ends lapsed runs, `endRuns` in `run-fleet.ts`). The
    attempt is spent; the campaign counts it once (below).
  - a **pause** on one member (a provider refusal, `observation-stalled`,
    `infrastructure-failed`, the usage gate) → the other four are paused
    `party-paused` with the same detail. A paused party is resumable as a
    unit: the campaign says `resume: true`, `planResumes`
    (`infra/run-fleet-plan.ts`) groups paused runs by `config.party.id`,
    waits until every member's account is free and no member is held
    (cooling, usage window), and emits one spawn with five entries and
    `--resume-roster`; the roster already resumes per spec from the run row.
    A party whose members cannot all come back is listed, not half-resumed.
  - a member that **dies in the game** is not a harness event: the character
    is a ghost at the Westfall graveyard the server picks (`graveyard_zone`
    has three for zone 40), runs back, or is resurrected by the priest. The
    other four keep playing. The idle watchdog (20 m without model output,
    `runner/src/watchdogs.ts`) is per member and does not fire on a member
    that is dead but thinking.
  - a member whose **heartbeat goes cold** with no row written (a killed
    pod) is seen by the roster as its launcher's exit, which is the
    termination case above.
- **Clocks and watchdogs** stay per run: the same `episodeMs` on all five
  from one launch instant, idle per member, the no-XP watchdog off as on
  every probe (`docs/EPISODES.md`, `probing`). The first `episode-limit` ends
  the party, which lands within a tick of the others' own.
- **Linking the five trajectories.** `meta.config.party` on every run:
  `{ id, member, role, size, members: [{ member, role, runId, account,
  character }] }`, stamped at launch from `campaign.json`, which carries the
  party definition (§7 for what reads it). `readRunFact`
  (`runner/src/models.ts`) surfaces `party`, and `ProbeRun` gains
  `party: string | null`.
- **Counting.** `campaignSquares` tallies distinct party ids per square: an
  attempt is one launch of five; it is *counted* when all five members are
  counted and no member is `launch-failed`; `live` while any member is. A
  party cell's `runsPerCell` therefore means parties per cell, and
  `maxAttemptsPerCell` caps party launches.
- **Capacity.** A party counts five against its concurrency keys
  (`concurrencyKeyOf`, `policy.maxConcurrent`) and five against
  `policy.paid.maxConcurrent`; the planner admits it only when there is room
  for all five, never a partial party. The first campaign is pinned to its
  accounts (§2), so the pool planner is not involved; a pool-scheduled party
  (five free pool accounts at once) is a later generalisation and is not
  needed to run the eval.

Resume semantics, stated plainly: a party resumes whole or not at all; a
member's run keeps its own trajectory, scratchpad and character
(`--resume` reattaches to the module session, `runner/src/run.ts`); the
claude-code driver comes back with a fresh CLI session as it does today
(`resumedFresh`). A party that is ended rather than paused is a failed
attempt for the square; its characters are deleted and re-staged by the next
attempt (§3), never continued.

## 2. Accounts

**What exists.** Three account classes, `accounts.pool | paid | local`
(`infra/run-fleet-config.ts`, `FleetAccounts`); a pinned job or a pinned
campaign names one `account` and is never the policy's; the preflight gate's
accounts may not be in the pool or on a job; the module serves only the
accounts in `worldserver.accounts` (`infra/chart/wrathbench/values.yaml`,
`WrathBench.Accounts`), read at worldserver recreate; `bun wb accounts
ensure NAME…` inserts an account into the auth DB with the server up
(`infra/bootstrap/bootstrap.ts --accounts-only`); the module holds one live
session per account, which is why the group smoke uses two
(`infra/smoke/group.ts`).

**The set.** Five accounts, `PARTY1` … `PARTY5`, reserved for party work and
nothing else:

- `campaigns.<id>.accounts: ["PARTY1", …, "PARTY5"]` — the pinned-campaign
  `account` generalised to a list (`campaignRowSchema` in
  `runner/src/campaigns.ts`; `pinnedCampaignJobs` in `run-fleet-config.ts`
  hands the list to the spawn). A party campaign with fewer than its party
  size is refused by name like any other bad row. The clash rules extend
  unchanged: a party account may not be in the pool, the paid or local class,
  on a queue job, or a gate account; two enabled pins on one account keep the
  first.
- They are never `RUNNER*`, so hygiene's "a benchmark run starts from a
  character the agent created" rule for the scored lanes is untouched; the
  fixture tool's `ACCOUNT_PATTERN` (`infra/fixtures/apply.ts`) widens from
  `^(SMOKE\d*|PROBE)$` to admit `PARTY\d`, because staging a loadout is the
  operator's decision for this lane.
- `policy.maxConcurrent` needs room for five on the model's key: nothing to
  change for a claude-code lane (the store caps none today; the usage gate is
  the limit), `codex: 5` for a Codex party (one `CODEX_HOME`, five processes
  on one `auth.json` — the refresh-token race the Codex notes already warn
  about), `paid.maxConcurrent ≥ 5` for a paid API model.

**The chart change, one release window:** `worldserver.accounts` gains
`PARTY1`–`PARTY5`; the staging account (§3) `STAGER` is created with gmlevel
3 by a sibling of `infra/spectator-account.ts` (`bun wb accounts stager`,
password on stdin) and is **not** added to the module allowlist — no bench
session can ever be opened on it. Both are read at recreate, so they ship in
the same window as the module changes of §5 and §7, and `bun wb accounts
ensure PARTY1 PARTY2 PARTY3 PARTY4 PARTY5` runs before it.

## 3. Loadout staging (issue #33)

Five fresh characters have to be level 20, know their class's spells and
talents, carry green gear, and stand in Moonbrook — with no item guid
collision and no reaping on the next worldserver boot.

**What the fixture does today** (`infra/fixtures/scenarios.ts`,
`infra/fixtures/apply.ts`): on a SMOKE/PROBE account, after the character's
logout save has landed (`waitUntilOffline` polls `characters.online = 0` and
`logout_time`), one SQL transaction sets level, xp, money, position, zone,
homebind, health and powers full, `character_spell` rows (INSERT IGNORE,
specMask 255), the taxi mask, achievements and the quest log. **No items,
deliberately:** `item_instance` guids come from a generator seeded at boot
from `SELECT MAX(guid)` (`ObjectMgr::SetHighestGuids`, the pinned core's
`src/server/game/Globals/ObjectMgr.cpp`), and the same function then runs
one-time `DELETE`s against `character_inventory`, `mail_items`,
`auctionhouse` and `guild_bank_item` for every row at or above that
watermark. Rows written from outside while the server is up are both racy now
and reaped later. Everything the loadout needs *except gear* is this tool
plus two more row kinds of the same shape.

### The routes

**(a) Gear through the live server — vendor or quest.** `buyItem` exists and
vendors are where whites and consumables come from, but level-20 greens are
quest rewards and drops: a vendor route cannot reach them, and a quest route
means playing hours of Westfall, Loch Modan and Redridge chains per character
per attempt. Right for water, food, bandages and ammunition if nothing else
carries them; not a staging route for gear.

**(b) Write items with the world stopped and reseed the watermark.** Guid-safe
by construction *while the server is down*: rows written then are below the
next boot's `MAX(guid)`, so the generator starts above them and the DELETEs
spare them. But every restaging is then a worldserver recreate, which is a
deploy window and nothing else — "never restart the worldserver while a run
is live" (`.claude/skills/fleet-readonly`). A campaign restages five
characters per attempt. Rejected as the route; kept as the fallback inside a
release window if (c) is refused.

**(c) The core's own command path at staging time.** `.additem <name> <item>
[count]` (`HandleAddItemCommand`, `src/server/scripts/Commands/cs_misc.cpp`)
stores through `Player::StoreNewItem` → `Item::CreateItem`, which takes its
guid from `sObjectMgr->GetGenerator<HighGuid::Item>().Generate(realmId)`
(`src/server/game/Entities/Item/Item.cpp`) — the live generator, on the world
thread (`World::ProcessCliCommands` runs inside `World::Update`), saved by the
player's own `SaveInventoryAndGoldToDB` at logout. The command requires the
target online ("Adding items requires the target to be online", the same
handler). The console is interactive and needs the pod's tty; SOAP is HTTP on
7878, authenticated against an auth-DB account of `SEC_ADMINISTRATOR` or
above (`src/server/apps/worldserver/ACSoap/ACSoap.cpp`) and queues the command
onto the same CLI queue. It is off today: `AC_SOAP_ENABLED: "0"` in
`infra/chart/wrathbench/templates/worldserver.yaml` and `infra/compose.yml`,
and `SOAP.IP` defaults to loopback.

Is it within the contracts? `docs/CONTRACTS.md` binds what the **agent**
observes and how the **agent** acts; its one sentence on GM commands is that
the module never uses them "to perform an action on the agent's behalf".
Staging runs before the run, on the operator's credential, through nothing
the agent can reach — the same standing `infra/README.md` gives the fixture
SQL ("a fixture is the operator arranging the world before the run, the same
way an operator picks which account a smoke logs into"). The repository had
repeated a stronger sentence, "SOAP is off by contract" (`bootstrap.ts`, the
chart's and the compose file's `AC_SOAP_ENABLED` comments, `infra/README.md`,
`infra/fixtures/apply.ts`), which overstated the contract; those now say what
it binds, and that the quickstart keeps SOAP off. The operator decided
(2026-10-19): SOAP on, in-cluster only, an admin-level `STAGER`, used solely
by the stager before a party launches.

**How it stays out of the agent's reach**, in four layers, each enough on
its own:

1. **The sandbox's network guard.** The snippet child runs under a Landlock
   ruleset (`runner/src/sandbox/confine.ts`; `docs/CONTRACTS.md`,
   "Control-surface authentication") whose TCP rule admits `connect` to one
   port, the one in the run's module URL (8086). Landlock's rule is per port,
   so 7878 is refused by the kernel on every address, however the snippet
   reaches for it. This holds in a run pod and in a child process alike.
2. **The run pods' NetworkPolicy.** A run pod's egress admits the module on
   8086, cluster DNS, TCP 443 outside the private ranges, and the listed
   local model hosts (`infra/chart/wrathbench/templates/networkpolicy.yaml`);
   7878 on a cluster address is dropped. The fleet pod's egress gains one rule,
   the worldserver on 7878, because the stager runs in the roster before a
   fresh party launch; the runner pod, where `bun wb` runs the staging smoke
   by hand, is inside the namespace already.
3. **Where SOAP listens.** `SOAP.IP` on the pod address with 7878 on the
   worldserver's ClusterIP Service — reachable inside the namespace and from
   an operator's port-forward, nothing else, exactly as the module port is
   described in `worldserver.yaml` — and an ingress rule on the worldserver
   admitting 7878 only from the fleet and runner pods' labels, so the pod
   address is no wider than the Service. The compose quickstart keeps
   `AC_SOAP_ENABLED: "0"`: it has no policies to contain it with, and no
   party campaign runs there.
4. **The credential.** `STAGER`'s password is a Secret mounted into the fleet
   and runner pods beside the fixture tool's MySQL password; the run-pod env
   builder's allow-list never carries it, and `infra/run-pod.test.ts` gains
   the same assertion it makes for `ANTHROPIC_*`. `STAGER` is not on the
   module's account allowlist, so no bench session can be opened on it, and
   SOAP itself refuses any account below `SEC_ADMINISTRATOR`.

**(d) Anything else.**
- A GM-level account logged in *through the module*, typing `.additem` as a
  `say`: the chat handler parses commands for GM sessions, so it would work,
  guid-safely. Rejected: it puts a privileged path on the agent's own control
  surface and in the module's audit log, which is precisely the mixing the
  contract exists to forbid.
- Filling guid holes below the watermark: the generator never reuses a
  number and the boot DELETE only looks above `MAX(guid)`, so a free guid
  below the boot watermark is safe — but SQL cannot see the boot watermark,
  only the current maximum, and a hole between the two may be an item that
  exists in memory and is not yet saved. No proof; rejected.
- `playercreateinfo_item`: gives every new character of a race and class the
  listed items at creation, through the client's own create. Global, so it
  would reach the scored lanes' level-1 characters; and a world-table change
  is a restart. Rejected.
- `.send items <name> …` over SOAP: `MailDraft` allocates guids live and
  delivers to an offline character, so it needs no staging login; the gear
  then sits in a mailbox, and Moonbrook has none. The fallback if the online
  step in (c) proves awkward; the agent would start at the Sentinel Hill
  mailbox instead.

### The pick: (c) for gear, the fixture tool for everything else

Per member, per attempt, in `infra/fixtures/stage-party.ts` (operator tooling
beside `apply.ts`, never imported by `runner/` or `sdk/`), run by the roster
before a fresh party launch and by hand for the smoke:

1. Delete last attempt's character through the module (`POST
   /character-delete`, a `CMSG_CHAR_DELETE`, which also clears the core's
   name cache — a DB delete does not). Create the member through `POST
   /session` with the role's race and class, then `DELETE /session`; these
   are the utility sessions the fixture smokes already make
   (`infra/smoke/lib/fixture.ts`).
2. Wait for the logout save; apply the member's scenario: level 20, xp 0, a
   few gold for repairs, position in Moonbrook, homebind Sentinel Hill,
   `clearQuests`, spells, talents, skills. Spells are the class's trainer
   spells with `reqlevel ≤ 20`, read from the world DB's `npc_trainer` at
   staging time rather than hard-coded; talents are preset per role (the
   operator's decision) as `character_talent` rows (`guid, spell,
   specMask`), the same shape as `character_spell`, loaded by
   `Player::_LoadTalents` → `addTalent`; skills are an UPDATE of the
   character's existing `character_skills` rows to the level's maximum (the
   loader keeps the stored value and recomputes the maximum).
3. Log the member in again under the stager's own token, run `.additem
   <Name> <item> [count]` over SOAP for each loadout line (gear, two bags,
   consumables), `DELETE /session`, wait for the save.
4. One more offline UPDATE moves each gear row in `character_inventory` from
   its bag slot to its equipment slot (bag 0, slot by the template's
   `InventoryType`); on the next login `_LoadInventory` equips what the
   character may wear. This touches `bag` and `slot` on existing rows and
   never a guid. If the smoke shows the loader bouncing an item, the fallback
   is to leave the gear in the bags and have the launch note say so: five
   `equipItem` calls are inside the surface.
5. With all five staged, log all five in under staging tokens, form the
   party through the SDK (`inviteToGroup` × 4, `acceptGroupInvite`, the
   warrior leading), log out: the party is pre-formed at staging, by the
   operator's decision, so nobody crosses the portal alone and the attempt
   starts at the dungeon. A party survives its members' logout unless
   `LeaveGroupOnLogout.Enabled` is on (`WorldSession::LogoutPlayer`; the
   core's default is 0 and the chart does not set it), so the members log in
   grouped and `SMSG_GROUP_LIST` arrives with the login burst. Group guids
   come from a generator seeded at boot like item guids, so the group is
   formed through the client path and never written as rows.

**Why it is guid-safe, in four lines.** Every item guid is handed out by the
running server's generator, on the world thread, inside the same
`StoreNewItem` a loot or a purchase goes through. Every row reaches
`item_instance` through the player's own save. Nothing is inserted from
outside, so no guid can collide with one the server is about to hand out.
The next boot's `SELECT MAX(guid)` includes them, so the one-time DELETEs at
or above `GetNextAfterMaxUsed()` never reach them. The offline UPDATE of step
4 changes positions, not identities.

**What the smoke must show** (`infra/smoke/party-staging.ts`, on
`PARTY1`–`PARTY5`): after staging, each member logs in through the SDK and
the state cache reads level 20, the scenario's position within a few yards,
the loadout's item ids in equipment slots (`slot < 19`), the role's key
spells in the spellbook, the listed talents in `SMSG_TALENTS_INFO`, the
money, and `state.group()` listing the other four with the warrior as
leader; then logs out and deletes through the module. The reaping half
cannot be proven without a boot, so it is proven once, in the release window
that enables SOAP: stage, let the window recreate the worldserver as it does
anyway, run the same assertions after. From then on the construction above
is the proof, as it is for every item a run buys.

The item ids themselves are the fixture PR's to choose (uncommon quality,
required level 15–20, wearable by the class, named with their ids in
`scenarios.ts` the way every other fixture names its NPCs and objects); this
design fixes the constraints, not the list.

## 4. Entering Deadmines

The facts, read from the pinned core's base world SQL
(`deps/azerothcore/data/sql/base/db_world/`) and the client's own DBCs on
the data volume, not from the live world DB:

- `instance_template`: map 36, script `instance_deadmines`. `Map.dbc` 36:
  `InstanceType` 1 (a party dungeon), name "Deadmines", 10 players maximum.
  `dungeon_access_template` row 3: map 36, difficulty 0, minimum level 10.
  `LFGDungeons.dbc` 6 "Deadmines": levels 15–25, target 17–20. A level-20
  party satisfies every gate.
- The way in: `AreaTrigger.dbc` 78 on map 0 at (-11208.5, 1685.3, 25.8),
  radius 7, which `areatrigger_teleport` 78 "DeadMines Entrance" sends to map
  36 at (-16.4, -383.07, 61.78). The way out: trigger 119 just inside (map
  36, (-14.4, -393.4, 64.6), radius 6) back to map 0 at (-11208.3, 1672.5,
  24.7), and trigger 121 at the far end of the ship cavern (map 36, (-110.8,
  -1009.2, 34.8)) up to the Westfall shore at (-11339.4, 1571.2, 100.6).
- Moonbrook: `game_tele` 635 at (-10986.7, 1542.75, 44.8), map 0. The portal
  is about 260 yards away down the mine's outer tunnels — the Westfall
  subzone "The Deadmines", Defias around level 17–19 — so the approach is
  part of the attempt.

**Is walking in client-legal?** Yes, and it is already how the module
behaves. `Manager::CheckAreaTriggers` (`module/src/WbManager.cpp`) tests the
mover's position against the DBC volumes on every heartbeat, and the live
position once per tick when nothing is driving it, and queues
`CMSG_AREATRIGGER` once on entering a volume, exactly as a client does
without the player choosing to (`docs/CONTRACTS.md`, "Pathing"). The core's
handler looks the id up in `areatrigger_teleport`, checks the access
requirement, and teleports: `SMSG_TRANSFER_PENDING { map: 36 }`, the move
ends `transferred`, `SMSG_NEW_WORLD` carries the arrival, the module answers
`MSG_MOVE_WORLDPORT_ACK` itself (`module/PROTOCOL.md`, "Map transfers") and
`WB_AREA` announces the new map. The `tram-ironforge` scenario and the
travel smoke prove this exact sequence on trigger 2175 into map 369; an
instance differs only inside the core (`InstanceMap::AddPlayerToMap` puts a
grouped player into the group's instance, an ungrouped one into a private
one — which is why §3 forms the party before anyone crosses). A refusal is
`SMSG_TRANSFER_ABORTED`, already whitelisted.

**Is it reliable?** Two things the smoke has to show rather than this
design assume: that the navmesh is continuous from Moonbrook's street through
the mine building and its tunnels to the trigger (the tunnels are WMO
interiors, which the mmaps include, as the Northshire abbey walk in
`infra/smoke/area-and-roles.ts` already relies on), and that map 36 has a
mesh on the data volume at all (a `move_to` inside answering `no_mesh` is
the tell). Both are one afternoon's smoke, not a design risk.

**The single-character smoke** (`infra/smoke/deadmines-entry.ts`, on
`PROBE`): scenario `moonbrook-mine` at level 80 so nothing on the way
interrupts the walk (the steep-replan fixtures use the same trick); `moveTo`
the trigger point, expecting `transferred`; assert `SMSG_TRANSFER_PENDING`
and `SMSG_NEW_WORLD` with map 36 and a `WB_AREA` for it; one `moveTo`
inside that arrives; the first Defias pack in `units()`; then `moveTo`
trigger 119 and see map 0 again. It is the gate for enabling the campaign,
and it belongs on the release's deploy smokes while the campaign runs.

**The Dungeon Finder is unnecessary.** `CMSG_LFG_JOIN` and its replies are
a dozen opcodes and a proposal dialogue, all to teleport a formed party to
the same spot a three-minute walk reaches, and the walk is the better eval:
the approach is the dungeon's first pull. It stays deferred exactly as
`docs/CONTRACTS.md` lists it; nothing here needs it.

## 5. The party surface

**What exists.** The party actions on the raw allowlist (`CMSG_GROUP_INVITE`,
`ACCEPT`, `DECLINE`, `UNINVITE[_GUID]`, `DISBAND`, `SET_LEADER`,
`CMSG_LOOT_METHOD`, `CMSG_LOOT_ROLL`), the party taps (`SMSG_GROUP_INVITE`,
`SMSG_GROUP_LIST`, `SMSG_PARTY_COMMAND_RESULT`, `DECLINE`, `UNINVITE`,
`SET_LEADER`, `DESTROYED`), `state.group()` and the invite/accept/leave
helpers (`sdk/API.md`), party chat and whispers through raw
`CMSG_MESSAGECHAT` with `SMSG_MESSAGECHAT` decoded per type into
`state.chat`, loot rolls (`state.pendingRolls()`, `lootRoll`), and the
other members as nearby players: `health`, `maxHealth`, the powers, `level`,
`targetGuid` and `playerFlags` ride the unit update fields every client in
range receives (`module/PROTOCOL.md`, the update-field whitelist). In a
dungeon the party is in range almost always, so who the mob is hitting and
how the healer is doing are observable today.

**What this eval needs, and the change for each.** Only what five agents in
one dungeon cannot do without; everything else waits for a trajectory.

| need | why the eval needs it | change |
|---|---|---|
| Accept a resurrection | A dead member either walks back from the graveyard as a ghost or accepts the priest's Resurrection. `CMSG_RESURRECT_RESPONSE` is on the raw allowlist, but `SMSG_RESURRECT_REQUEST` is not tapped, so the dead member cannot see the offer it may answer | module: whitelist `SMSG_RESURRECT_REQUEST` (`Spell::SendResurrectRequest`: `u64 caster, u32 len, cstring name` — empty for a player caster, whose name the client looks up by guid — `u8 sickness`, and a trailing `u32 0` only for spells with no resurrection timer); SDK: `state.pendingResurrect` and `acceptResurrection()` / `declineResurrection()` over the existing raw |
| Party chat and whispers without a hex body | Chat is the coordination channel of this eval; the raw path works but every member hand-builds `CMSG_MESSAGECHAT` bytes | SDK only: `say(text, { type: "say" \| "party" \| "yell" \| "whisper", to? })` over the same raw opcode; the module changes nothing. Recommended for the first campaign: a hex body on the one channel the eval turns on is friction that measures nothing. A surface change, so still the operator's call (open question 3) |
| The kill record | §7 | module: whitelist `SMSG_PARTYKILLLOG` (`u64 killer, u64 victim`; `Unit::Kill` broadcasts it to the killer's group, or sends it to the killer alone) |
| The instance record | §7 | module: load `Map.dbc` beside `AreaTable.dbc` and serve `mapName` and `instanceType` on `WB_AREA` and `WB_SESSION_STATE` — client-cache knowledge over a packet already served, the pattern the zone names follow |

**Deferred, with the change written down so it is not re-derived.**

- `SMSG_PARTY_MEMBER_STATS`: the core sends it only for a member out of the
  receiver's sight range (`Group::UpdatePlayerOutOfRange`); in range the unit
  fields already carry everything it would. A ghost member at the graveyard
  is out of range, and chat covers that. If a trajectory shows a loop needing
  a far member's state: decode the `GROUP_UPDATE_FLAG` mask
  (`WorldSession::BuildPartyMemberStatsChangedPacket`) and the `_FULL` reply
  to `CMSG_REQUEST_PARTY_MEMBER_STATS`.
- Ready check: any party may use it (leader or assistant starts; the check is
  not raid-only), but "ready?" in party chat is the same act. If earned: raw
  `MSG_RAID_READY_CHECK` (empty to start, `u8 state` to answer) and
  `MSG_RAID_READY_CHECK_FINISHED`; taps `MSG_RAID_READY_CHECK` (`u64
  requester`) and `MSG_RAID_READY_CHECK_CONFIRM` (`u64 guid, u8 state`).
- Raid target icons: any party member may set one
  (`HandleRaidTargetUpdateOpcode` gates only raids on leader/assistant); the
  broadcast is `u8 0, u64 setter, u8 icon, u64 target` and the list form `u8
  1, (u8 icon, u64 target)…` (`Group::SetTargetIcon`, `SendTargetIconList`).
  A name in chat with bounded fuzz names the same target today. If earned:
  one `MSG_` opcode raw and tapped, like `MSG_TALENT_WIPE_CONFIRM`.
- `CMSG_PUSHQUESTTOPARTY`: no quest is part of the objective, so nothing
  needs sharing. If a later loadout carries the Deadmines quests: the push
  is raw, the answer `MSG_QUEST_PUSH_RESULT` tapped, and the recipient sees
  the ordinary `SMSG_QUESTGIVER_QUEST_DETAILS`.
- Threat (`SMSG_THREAT_UPDATE` and kin, a 3.3.5 client's own threat meter):
  `targetGuid` on the mob says who it is hitting, which is the question a
  tank and a healer ask first. A tap when a trajectory shows the finer
  reading is needed.
- Following: a client follows locally; `moveTo` to the leader's position
  re-issued is the composition, and compositions live in snippets until
  every model writes the same one (`docs/METHODOLOGY.md`, "The model
  surface").

## 6. Records

Three milestone kinds, additive like every other (`MilestoneLine` in
`runner/src/trajectory.ts`), produced in `runner/src/loop.ts` from packets
the server sends, never from a map-id read off a state sample:

- **`group`** — from `SMSG_GROUP_LIST` as `state.group()` folds it: `{ kind:
  "group", event: "joined" | "changed" | "left", groupGuid, leaderGuid,
  members: [guid…], count }`. Guids and counts only, never names. The staged
  party's login list writes `joined` on every member, which is the record
  that says the party existed for this run, the way `achievements_at_login`
  says the taps were live.
- **`instance`** — from the map transfer: `SMSG_TRANSFER_PENDING` and
  `SMSG_NEW_WORLD` are the server telling the client where it is now, and
  the `WB_AREA` that follows carries the map with the module's `Map.dbc`
  reading of it (§5). `{ kind: "instance", event: "entered" | "left", map,
  instanceType, from }`, written when `instanceType` differs across the
  change. Ids only; the name sits on the `WB_AREA` event beside it. Why not
  the packets the earlier proposal named: `SMSG_UPDATE_INSTANCE_OWNERSHIP` is
  `Player::SendSavedInstances`, a flag saying whether the player holds any
  *permanent* bind, and `SMSG_INSTANCE_SAVE_CREATED` is sent by
  `PermBindAllPlayers` — raids and heroics. A normal five-man binds nobody,
  so neither ever says "you entered the Deadmines"; the transfer does.
- **`kill`** — from `SMSG_PARTYKILLLOG`: `{ kind: "kill", killerGuid,
  victimGuid, entry, rank, self }`, with `entry` from the SDK's unit cache
  and `rank` from the creature query it already holds. Recorded for victims
  of rank 1 and above (elites, rares, bosses) so an open-world run does not
  write a line per rabbit; every Deadmines creature is elite, so inside the
  instance it is every kill.

Boss kills are a derivation, offline: the Deadmines bosses by creature entry
— 644 Rhahk'Zor, 643 Sneed and 642 his shredder, 1763 Gilnid, 646 Mr. Smite,
647 Captain Greenskin, 639 Edwin VanCleef, 645 Cookie — all `rank` 1 in
`creature_template`, so the entry and not the rank is the key. A second,
independent say-so already exists and needs no change: `Achievement.dbc`
628 "Deadmines" (10 points) is awarded for VanCleef, and the `achievement`
milestone records each member's own earn. Achievements stay unranked, as
decided; here it is one more server statement that the clear happened.

**What the campaign page reads**, per party: every member entered map 36
(`instance`), the bosses killed as the union of the five `kill` series by
victim guid, VanCleef and 628 per member, deaths per member (existing
records), wall clock from the first `instance entered` to the VanCleef kill,
and the five termination reasons. A wipe is derivable as five deaths with no
`resurrect` between them. **What a later scored episode would read** is the
same signals through a derivation the operator settles then (cleared or not,
time to clear, deaths, wipes); nothing is scored now, and the recording
above is designed so that nothing needs re-running when it is. The ladder's
rung 6 (`dashboard/src/lib/ladder.ts`, `RUNGS` n 6, today `test: null`)
becomes derivable from `instance entered 36` plus a `kill` of 639 across one
party of one model, which is the operator's reading of "a party of agents".

## 7. Budget and cost

**Wall clock.** Human parties at the target level clear the Deadmines in
one to one and a half hours including the approach; agent loops add turn
latency, corpse runs and coordination. A 4-hour `episodeMs`, idle 20 m, no-XP
off, `maxToolCalls` 8000 (the standing 1000-per-30-minutes runaway guard
over four hours), staging about five minutes before it. Five run pods per
attempt; `maxAttemptsPerCell: 3` bounds a square at twelve pod-hours plus
staging.

**Model cost per attempt**, from `docs/COSTS.md` and the recorded runs:

- A paid API model under the fixed loop plateaus at 8–12k prompt tokens a
  turn; DeepSeek V4.1 Flash's e360 cost $2.38 for six hours, so about $8 for
  five loops over four hours, about $25 for a three-attempt square. No lane
  constraint beyond `paid.maxConcurrent ≥ 5`.
- A Claude model is subscription-only (`docs/METHODOLOGY.md`, the lane
  rules): $0 marginal, but a Sonnet e360 metered at about $44, so a party
  attempt draws roughly $150 as-metered from one lane's usage window. The
  store caps no claude-code lane today; the 80% usage gate holds a launch,
  and a quota pause on one member pauses the party (§1). Five concurrent
  sessions on one OAuth token is new ground for the lane, and the gate's
  reading is per window, not per planned session, so the first party launch
  should go out with the lane well under its threshold.
- Codex: `codex` capped at 3 in the store; a GPT party needs 5 on one
  `CODEX_HOME`, which is five processes refreshing one token.

**Which models first.** The shakedown of the mechanics — staging, entry,
the records, the party job — on the cheapest paid API model that has climbed
(DeepSeek V4.1 Flash reached L7 in an e360): an attempt costs less than a
coffee and nothing in a subscription window. Then the question itself on a
Claude model on lane 2, where Sonnet 5.5 and Haiku 5.5 at max effort are the
rows that climbed furthest, when the lane has headroom for five sessions. The
model is the operator's to name, as every roster entry is.

## 8. The prompt

Three pieces of harness text, identical for every model. **Both texts below
are drafts**: prompt wording is the operator's, and these ship only in the
words he gives them (open question 2). Nothing else about the prompt
changes: the standing goal, the body and the tools are the same as every
run's (`runner/src/prompt.ts`).

**The staged-character launch note** (draft), a sibling of
`freshCharacterNote` for a run launched with the new `--character <name>`
flag (hygiene keeps the named character the way `--continue-from` keeps a
freeplay one, `runner/src/run.ts`; the flag is refused with
`--race`/`--class`):

> Your character already exists: `<Name>`, a level 20 `<race> <class>`. Log in
> with `await sdk.createSession({ character: "<Name>" })`. Do not create
> another character.

**The operator objective** (draft), rendered in the delimited block
`objectiveSection` already draws for a probe (per member, from the party
definition's `members[].objective`):

> You are one of a party of five, each played by another agent: `<Tank>`
> (warrior, the party leader), `<Healer>` (priest), `<Mage>` (mage),
> `<Rogue>` (rogue) and `<Hunter>` (hunter). You are `<Name>`, the party's
> `<role>`. The party stands in Moonbrook, Westfall, at the entrance to the
> Deadmines. The objective for this run is for the party to clear the
> Deadmines and defeat Edwin VanCleef. You share party chat with the others
> and can whisper any of them.

Roles are one word each — `tank`, `healer`, `damage` — and the text says
what the party is, not how to play it: what to pull, who to heal first and
when to drink are strategy, which the prompt never teaches
(`docs/METHODOLOGY.md`, "A fact about the world is in the prompt's remit; a
strategy hint is not"). Naming VanCleef is the objective, which a probe may
carry; it is also why the lane is unscored until the operator decides
otherwise.

**The HUD** needs no new line: `state.group()` is already summarised when
present, and the chat tail already carries party and whisper lines with
their type.

## 9. Phases

Independently mergeable, in build order; each names its verify step. "Release"
means the change reaches the fleet only through `bun wb release run`;
"decision" means it waits on an open question below.

1. **Module** (`module/`, `module/PROTOCOL.md`): load `Map.dbc`; `mapName`
   and `instanceType` on `WB_AREA` and `WB_SESSION_STATE`; whitelist
   `SMSG_PARTYKILLLOG` and `SMSG_RESURRECT_REQUEST`. Verify: `kill-credit.ts`
   asserts the kill log for its kills, `area-and-roles.ts` the map fields,
   `death-recovery.ts` gains a two-account resurrection arc. Release.
2. **SDK** (`sdk/`): event schemas for the two packets, `state.self.map`,
   `state.pendingResurrect`, `acceptResurrection`, and the chat `type`
   option on `say` (recommended; still the operator's call). Verify: the
   SDK's fixture tests and the smokes of phase 1. Ships with phase 1's
   release.
3. **Runner records and launch** (`runner/`): the `group`, `instance` and
   `kill` milestones in `loop.ts`; `--character`, the staged launch note,
   `meta.config.party`; `campaign-def.ts` gains `start: "fresh" | { staged:
   <scenario> }` and `party: { size, members: [{ id, role, race, class,
   objective }] }`, which also amends `docs/EPISODES.md`'s "a fresh level-1
   character" for the probing lane (the operator's loadout decision, recorded
   there). Verify: `bun run test runner/`, the replay, `bun run typecheck`.
   Release.
4. **Fleet** (`infra/run-fleet*.ts`, `run-roster.ts`, `campaigns.ts`, the
   campaigns page): `JobSpawn.accounts`, the roster's party mode, shared
   fate, `planResumes` by party, concurrency times five, `campaignSquares`
   by party id, `campaigns.<id>.accounts`, and the stager invoked by the
   roster before a fresh party launch. Verify: the infra fixture tests
   (`roster.test.ts`, `fleet.test.ts`, `resume-after-kill.test.ts` gain party
   cases), `bun wb fleet dry-run` against a party row. Release.
5. **Fixtures, staging and the chart** (`infra/fixtures/`, `infra/chart/`):
   the `PARTY\d` accounts in `ACCOUNT_PATTERN`, the `moonbrook-mine`
   scenario, the per-role talent lists, skills and the equipment move in
   `apply.ts`, `stage-party.ts` with a small SOAP client (the pre-forming of
   the party included), `bun wb accounts stager`; chart: `worldserver.accounts`
   gains `PARTY1`–`PARTY5`, `AC_SOAP_ENABLED` on with `SOAP.IP` on the pod
   address, 7878 on the worldserver Service, the worldserver ingress rule
   admitting 7878 from the fleet and runner pods only, the fleet's egress rule
   to it, the `STAGER` Secret, and the run-pod env test's new assertion.
   Verify: `apply.test.ts` on the statements, `networkpolicy.test.ts` and
   `run-pod.test.ts` on the rendered policies and env; the live proof is
   phase 6. Release.
6. **Smokes** (`infra/smoke/`): `deadmines-entry.ts` (one character, §4),
   `party-staging.ts` (§3), and `party-entry.ts` (five staged and grouped
   members cross the trigger and see each other inside: the same-instance
   proof). Verify: `bun wb smoke <name>` in the release window of phase 5,
   with the post-recreate re-check of §3 run once there; the entry smoke
   joins `deploySmokes` while the campaign is enabled.
7. **Campaign definition** (`runner/campaigns/deadmines@1.json`): one cell
   (the party), one arm on the release image, `start: staged`, the five
   members with their objectives in the operator's words, `objective` null
   at the top level, no `stopAtLevel`, the budget of §7, `wiki: true`,
   `wikiCoords: false`, `resume: true`, `maxAttemptsPerCell: 3`; the store
   row pinned to `PARTY1`–`PARTY5` with the first assignment. Verify: `bun wb
   campaign publish --dry-run`, then publish; no release. Enabled only after
   phase 6 passes, with the model the operator names (decision).

**What runs in parallel and what is serialised.** Phases 1, 3, 4 and 5 touch
disjoint trees (`module/`, `runner/`, `infra/run-*` with `campaigns.ts`,
`infra/fixtures/` with the chart) and can be built and reviewed on separate
branches at once; phase 2 follows phase 1, whose event names and shapes it
decodes, and is small enough to ride phase 1's branch. The module work is
serialised: one module change at a time, each verified by its smokes against
a deployed build, and nothing in phases 3–5 depends on the module being
first — the records read packets the SDK already decodes until the new taps
land, and the kill and resurrect producers simply stay silent before them.
The release window is the join: phase 1's module build, phase 5's chart
values and the accounts land in one window, because `worldserver.accounts`,
`AC_SOAP_ENABLED` and the module image are all read at worldserver recreate,
and phase 6's smokes run inside that window. Phase 7 is after 6, and nothing
else waits on it.

## 10. Open questions for the operator

Only what the decisions above do not answer.

1. **The first model**, and whether the shakedown attempts on a cheap API
   model run under the same campaign version as the Claude attempts or under
   their own.
2. **The objective and role wording** — the two drafts in §8, whether "clear
   the Deadmines" should also name the other bosses, and whether the per-role
   word is enough or too little. The operator words it; the drafts ship only
   as he gives them.
3. **The chat helper.** `say` with a `type` is a surface addition made on
   this eval's need rather than a citable trajectory. The recommendation is
   to add it for the first campaign (§5); the alternative is to leave chat
   raw and read what the first party does.
4. **Promotion.** When the mechanics settle, the scored form is a new episode
   id with its own comparability tuple fields (`party`, the loadout's
   identity, the staging scenario), not a widening of `probing`; the
   derivation that makes it a score is the decision this design defers, as
   instructed.
