CREATE TABLE run (
  run_id TEXT PRIMARY KEY,
  harness_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- The driver is its own column, not just a key inside config_json: a
  -- cross-run SELECT must be able to exclude stub runs without parsing.
  -- shakeout is the unscored stamp (legacy column name, see RunMeta).
  driver TEXT,
  shakeout TEXT,
  model TEXT,
  -- The operator objective this run was steered with, if any. Its
  -- own column for the same reason the driver has one: a cross-run SELECT must
  -- be able to exclude steered runs without parsing config_json.
  objective TEXT,
  -- The character this run played and the platform that served the model
  --. Both were derivable from config_json and from the api
  -- base; a column means a cross-run SELECT — and the viewer's listing — does
  -- not have to parse a blob or re-derive a rule that could drift.
  character TEXT,
  platform TEXT,
  -- What the provider actually served (RunMeta.resolved), promoted out of the
  -- driver's own first word: the CLI resolves the alias 'sonnet' to the id
  -- 'claude-sonnet-5' at launch, and a column means a cross-run SELECT can ask which Claude a row
  -- was on without replaying the trajectory.
  resolved_model TEXT,
  resolved_cli_version TEXT,
  -- And which backend served it (2026-09-16): an aggregator answers one slug
  -- from many machines, so "which provider was this row on" is a question a
  -- cross-run SELECT has to be able to ask without replaying the trajectory.
  resolved_provider TEXT,
  -- The freeplay run this one continues (RunConfig.continuedFrom): the
  -- lineage of a freeplay character, so a listing can follow it across
  -- the run ids the operator's disable/re-enable cycle gave it.
  continued_from TEXT,
  termination_reason TEXT,
  termination_detail TEXT,
  pause_reason TEXT,
  -- When the run's reflection window opened, NULL whenever none is open. A
  -- single nullable column rather than a table of transitions: the question
  -- the viewer asks is "is this character reflecting right now", and a window
  -- has no history worth keeping in sqlite: the reflect_window records in the
  -- trajectory are that history.
  reflecting_since INTEGER,
  config_json TEXT NOT NULL
);
CREATE TABLE state (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  level INTEGER,
  xp INTEGER,
  map INTEGER,
  x REAL, y REAL, z REAL,
  event_count INTEGER,
  last_seq INTEGER,
  -- Phase-1 signal vector groundwork: recorded, never scored here.
  money INTEGER,
  quests_completed INTEGER,
  -- The driver turn in flight when the sample was taken, so turns-to-level is
  -- derivable without replaying the JSONL. Nullable, like StateLine.turn.
  turn INTEGER,
  -- Zone and area ids: where the sample was taken, as the
  -- game's own area ids; names are rendered from the client's DBC, not stored.
  zone INTEGER,
  area INTEGER
, items TEXT, health INTEGER, max_health INTEGER, power INTEGER, max_power INTEGER, power_type INTEGER, next_level_xp INTEGER);
INSERT INTO run (run_id, harness_version, started_at, ended_at, driver, shakeout, model, objective, character, platform, resolved_model, resolved_cli_version, resolved_provider, continued_from, termination_reason, termination_detail, pause_reason, reflecting_since, config_json) VALUES ('v1p1-solo', '0.6-1', 1762000200000, 1762001401250, 'stub', NULL, NULL, NULL, 'Testwick', 'stub', NULL, NULL, NULL, NULL, 'episode-limit', 'fixture', NULL, NULL, '{"moduleUrl":"http://worldserver:8086","character":"Testwick","account":"RUNNER","race":1,"class":2,"driver":"stub","apiKeyEnv":"OPENROUTER_KEY","wikiCoords":false,"wiki":true,"extra":false,"maxToolCallsPerEpisode":500,"stepIntervalMs":3000,"stateIntervalMs":60000,"snippetTimeoutMs":30000,"sandboxPingGraceMs":2000,"runsDir":"data/runs","wikiBundle":"data/wiki/bundle.sqlite","watchdogs":{"idleMs":600000,"noXpMs":2700000,"episodeMs":21600000,"maxSandboxRestarts":3},"runId":"v1p1-solo"}');
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000200250, 5, 300, 0, -9000, -100, 80, 11, 10, 1000, 0, NULL, 12, 87, '[{"name":"Testing Mace","count":1,"equipped":true,"itemId":61101,"quality":1,"slot":16},{"name":"Testing Stone","count":1,"equipped":false,"itemId":61103,"quality":1,"slot":23,"bag":255},{"name":"Testing Cloth","count":3,"equipped":false,"itemId":61104,"quality":1,"slot":0,"bag":19}]', 120, 120, 0, 1000, 1, 2800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000260250, 5, 435, 0, -8920, -73.33333333333343, 80, 38, 37, 1037, 0, 1, 12, 87, NULL, 90, 120, 0, 1000, 1, 2800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000320250, 5, 570, 0, -8840, -46.666666666666764, 80, 67, 66, 1074, 0, 2, 12, 87, '[{"name":"Testing Mace","count":1,"equipped":true,"itemId":61101,"quality":1,"slot":16},{"name":"Testing Stone","count":1,"equipped":false,"itemId":61103,"quality":1,"slot":23,"bag":255},{"name":"Testing Sword","count":1,"equipped":false,"itemId":61105,"quality":2,"slot":24,"bag":255},{"name":"Testing Cloth","count":3,"equipped":false,"itemId":61104,"quality":1,"slot":0,"bag":19}]', 90, 120, 0, 1000, 1, 2800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000380250, 5, 705, 0, -8760, -20.00000000000008, 80, 95, 94, 1148, 0, 2, 12, 87, NULL, 90, 120, 0, 1000, 1, 2800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000440250, 5, 1090, 0, -8680, 6.666666666666583, 80, 124, 123, 1335, 1, 3, 12, 87, NULL, 90, 120, 0, 1000, 1, 2800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000500250, 5, 1225, 0, -8600, 33.333333333333236, 80, 151, 150, 1372, 1, 4, 12, 87, NULL, 90, 120, 0, 1000, 1, 2800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000560250, 6, 210, 0, -8520, 59.99999999999995, 80, 181, 180, 1409, 1, 4, 12, 87, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000620250, 6, 345, 0, -8440, 86.66666666666654, 80, 209, 208, 1446, 1, 5, 12, 88, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000680250, 6, 730, 0, -8360, 113.33333333333312, 80, 239, 238, 1670, 2, 6, 12, 88, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000740250, 6, 865, 0, -8280, 139.9999999999998, 80, 268, 267, 1707, 2, 6, 12, 88, '[{"name":"Testing Sword","count":1,"equipped":true,"itemId":61105,"quality":2,"slot":16},{"name":"Testing Stone","count":1,"equipped":false,"itemId":61103,"quality":1,"slot":23,"bag":255},{"name":"Testing Mace","count":1,"equipped":false,"itemId":61101,"quality":1,"slot":24,"bag":255},{"name":"Testing Cloth","count":3,"equipped":false,"itemId":61104,"quality":1,"slot":0,"bag":19}]', 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000800250, 6, 1000, 0, -8200, 166.66666666666666, 80, 296, 295, 1744, 2, 7, 40, 120, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000860750, 6, 1135, 0, -8120, 193.3333333333335, 80, 11, 332, 1781, 0, 8, 40, 120, '[{"name":"Testing Sword","count":1,"equipped":true,"itemId":61105,"quality":2,"slot":16},{"name":"Testing Stone","count":1,"equipped":false,"itemId":61103,"quality":1,"slot":23,"bag":255},{"name":"Testing Mace","count":1,"equipped":false,"itemId":61101,"quality":1,"slot":24,"bag":255},{"name":"Testing Cloth","count":3,"equipped":false,"itemId":61104,"quality":1,"slot":0,"bag":19}]', 120, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000921250, 6, 1520, 0, -8040, 220.00000000000037, 80, 40, 361, 1968, 1, 8, 40, 120, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762000981250, 6, 1655, 0, -7960, 246.66666666666723, 80, 68, 389, 2042, 1, 9, 40, 120, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762001041250, 6, 1790, 0, -7880, 273.3333333333337, 80, 95, 416, 2079, 1, 10, 40, 120, NULL, 105, 135, 0, 1000, 1, 3300);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762001101250, 7, 120, 0, -7800, 300, 80, 123, 444, 2116, 1, 10, 40, 120, NULL, 150, 150, 0, 1000, 1, 3800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762001161250, 7, 255, 0, -7720, 326.6666666666663, 80, 150, 471, 2153, 1, 11, 40, 120, NULL, 120, 150, 0, 1000, 1, 3800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762001221250, 7, 390, 0, -7640, 353.3333333333326, 80, 177, 498, 2190, 1, 12, 40, 120, NULL, 120, 150, 0, 1000, 1, 3800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762001281250, 7, 525, 0, -7560, 379.99999999999886, 80, 205, 526, 2264, 1, 12, 40, 120, NULL, 120, 150, 0, 1000, 1, 3800);
INSERT INTO state (run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES ('v1p1-solo', 1762001341250, 7, 660, 0, -7480, 406.66666666666515, 80, 232, 553, 2301, 1, 13, 40, 120, NULL, 120, 150, 0, 1000, 1, 3800);
