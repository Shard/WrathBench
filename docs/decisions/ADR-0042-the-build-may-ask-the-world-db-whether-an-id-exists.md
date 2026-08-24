# ADR-0042: The build may ask the world DB whether an id exists

Status: Accepted. Date: 2026-08-24. Approved by the operator the same day
(FOLLOW-UPS 62, the open decision ADR-0040 left).

## Context

ADR-0040 made the bundle a Wrath snapshot: a page with no revision before
2010-10-12 is a page about a world this server does not run, and it is dropped.
That is right about most of them and wrong about a minority. Of the 20,407 pages
with no pre-cutoff revision, 1,901 are provably post-Wrath and 15 say outright that
they are Wrath-or-earlier. The remaining ~18,700 say nothing either way, and no
amount of reading the wikitext fixes it: the evidence is not in the text.

There is exactly one place the evidence does exist. Those pages state a numeric id
about themselves — a quest id, an NPC entry, an item entry — and this server either
has that id or does not. ADR-0040 named this rule and deliberately did not implement
it, because the wiki tooling reads nothing from the server and crossing that line is
not an implementer's call.

## Decision

**The build may use the world DB as an existence oracle, and nothing else.** A page
with no pre-cutoff revision, no post-Wrath signal and no Classic-2019 signal is
admitted when an id it states about itself exists in the 3.3.5a world DB **under a
name that agrees with the page's subject**. The reason is `post_cutoff_id_match`, a
sixth admission counter.

The server is read once, offline, by `infra/export-world-ids.sh`: four SELECTs
against `acore_world` into `data/wiki/world-ids.json`, carrying id→name
(`quest_template.LogTitle`, `creature_template.name`, `item_template.name`,
`gameobject_template.name`, ~3 MB). The build takes that file with `--world-ids` and
reads nothing else, so it stays a function of files — dump plus export — and a
rebuild from the same two gives the same bundle. A live query would have made the
bundle a function of whatever the server held that afternoon, and put a running
container in the path of a build that is otherwise reproducible anywhere. Without
the flag the build is byte-identical to what it was and `meta.world_ids` says
`none`; with it, `meta.world_ids` records the export's `exported_at` and per-kind
counts, so a bundle built against a different export is visible on the comparability
tuple rather than inferred from a counter.

**The name is the discriminator, not a refinement.** On the id alone the door was
**0.62** precise: an exhaustive review of all 151 rows it admitted — two independent
reviewers, every title judged, the DB's own names joined in — came back 94 true, 57
false, worse than the 0.7 an 18-title sample had estimated. The false admits arrive
by three routes: a later boss inherits the entry of the one it replaced (the
Cataclysm Zul'Aman boss states Zul'jin's 23863), a page copy-pastes another page's
tooltip block (seven unrelated battle-pet, guild and companion pages all state
`itemid=44822`), and a stub carries a placeholder nobody corrected (a Deepholm rare
on entry 3868, a Blood Seeker here). Nearly every false admit's id belongs to
something the DB calls by a different name, and nearly every true one's does not.

The subject is the title with its namespace prefix and trailing parentheticals
removed, and agreement is one name's words being all of the other's, case and
punctuation folded: `Darkmoon Carnie` is `Darkmoon Faire Carnie`, `Rexxar/PI` is
`Rexxar`. Word containment and not substring, because `car` sits inside `carnie`;
measured over the same 151, exact-match and substring rules both lost real pages
this one keeps. The rebuild admits **95 pages** and refuses **53** on the name
(`pages_id_name_mismatch`, a subset of `pages_dropped_post_cutoff` and outside the
accounting identity — the number to read first if the rule is ever retuned). On the
same review's judgements that is roughly **0.85**, the remainder being the ~15
by-design admits below.

What the oracle never admits:

- **spell and unknown ids.** Spells live in the client's DBC files, not the world
  DB, so its silence about one is no evidence; an `unknown` id is a number whose
  kind the page did not state. Neither is looked up.
- **a page carrying a post-Wrath signal.** The id door sits last: out-of-game first,
  then a title that is a later expansion's own coinage, then the post-Wrath and
  Classic vetoes, then the explicit Wrath signal, then the id. A Cataclysm page that
  happens to state an id the expansion reused is dropped for what it says about
  itself.
- **a page that has pre-cutoff prose.** The door is for pages with no revision
  before the cutoff, which is the case it was reasoned about.

An admitted page is treated exactly like a `post_cutoff_wrath_signal` one: its prose
is the newest revision, because it is the only one there is, and the era cuts and
the out-of-world trim run over it unchanged.

## Consequences

- **CONTRACTS.md is untouched, deliberately.** This is a build-time input. The agent
  still sees wiki text and only wiki text, served by the same `search_reference`
  over the same bundle; nothing in the observation or action path learned anything.
  What changed is which wiki pages a build decided to keep. The honest residue is
  one bit per admitted page: that the id the page already states about itself is an
  id this server has. It is the page's own claim, confirmed, and it buys the agent
  nothing a search of the same page did not already offer.
- The export is server-derived and lives under `data/`, gitignored. It never enters
  git, like the dump and the bundle beside it. A contributor without a server builds
  without the flag and gets the old bundle.
- **The rule is much smaller than the estimate that motivated it.** Of the 22,727
  late pages it could have reached, 16,010 state no id at all — lore, tactics and
  disambiguation pages — and of the 6,717 that do, nearly all state an id in the
  40,000–130,000 range this server has never heard of. The undecidable population
  was mostly genuinely later content after all.
- **The name rule takes true pages with the false ones.** A page honestly about this
  world that states the wrong id — a Deadmines drop on another item's entry, a Wrath
  glyph on another glyph's — now fails, correctly by the rule and wrongly about the
  world. The id door only ever knew what the page claimed, and a page that claims
  someone else's id cannot be told from a page that inherited it.
- **~15 false admits survive by design**, their stub id *and* name both real here:
  Custer Clubnik, Foreman Fisk, Fern Feeder Moth, Malynea Skyreaver, Labor Captain
  Grabbit, Sergeant Curtis, Overseer Sylandra, Rebel Watchman, Singed Shambler,
  Royal Guard, Twilight Father, Horzak Zignibble, Greela "The Grunt" Crankchain,
  `Quest:Jaina's Locket`, `Quest:Sylvanas' Vengeance`. No rule reading wikitext and
  a name can see them, and per-title exclusions are not a rule; they are recorded
  here and in FOLLOW-UPS 62 as the measured residue.
- The rule cannot admit a page that states no id, so a lore page written in 2015
  about a 3.3.5 character is still dropped. That residue is unchanged.
- The reference surface changes for every lane at once, so this is a harness minor
  bump on the same terms as ADR-0040.
- `schema_version` stays 5. No table changes; the same `pages.text` column holds
  more rows.
