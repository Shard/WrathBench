# Spectating the world

Operator tooling for logging into the realm with your own 3.3.5a client and a
GM account, to inspect the world and watch benchmark characters play. This is
outside the agent path: `docs/CONTRACTS.md` binds the benchmark agent, not the
human at the keyboard. Per `docs/DATA-AND-LEGAL.md` both ports bind to
`127.0.0.1` explicitly and must never go further.

## Ports

- Authserver `127.0.0.1:3724` — live.
- Worldserver `127.0.0.1:8085` — declared in `infra/compose.yml`, but takes
  effect only when the worldserver container is next recreated. Until that
  deploy window you can authenticate but not enter the world.

## The account

Create or rotate the `SPECTATOR` account (full GM, expansion WotLK) with:

```
docker compose -f infra/compose.yml run --rm --no-deps \
  -e WRATHBENCH_SPECTATOR_PASSWORD=<password> \
  bootstrap bun run infra/spectator-account.ts
```

There is no default password; the script refuses to run without one. Passwords
are uppercased before hashing (as AzerothCore does) and capped at 16
characters by the 3.3.5a client.

## Pointing the client at the realm

The client must be build 12340 (3.3.5a); the realm's gamebuild check refuses
anything else. The extraction preflight already validated the local client.

1. In the client directory, edit `Data/enUS/realmlist.wtf` (locale directory
   may differ) to exactly: `set realmlist 127.0.0.1`
2. Start `Wow.exe`, log in as `SPECTATOR` with the password you set.
3. Pick the `WrathBench` realm, create a character, enter world.

## Observing without disturbing

First thing after logging in a character:

```
.gm on            enable GM mode
.gm visible off   invisible to players and mobs; mobs never aggro you
.gm fly on        fly for a better view
```

Getting around:

```
.appear <name>    teleport yourself to a character (they see nothing)
.goname <name>    same as .appear on this core
.tele <place>     teleport to a named location (.tele stormwind)
.gps              print your current position
.recall           return to where you were before the last teleport
.revive           revive your own character if you die
```

Do not use `.summon` on a benchmark character — it moves them.

## Etiquette during a measured run

Do not aid, attack alongside, heal, buff, trade with, or otherwise touch a
benchmark character or the mobs it is fighting during a measured run. With
`.gm on` and `.gm visible off` your presence is inert — mobs do not aggro GMs
and the character cannot see you — but any interaction invalidates the run.
Watch, take notes, touch nothing.
