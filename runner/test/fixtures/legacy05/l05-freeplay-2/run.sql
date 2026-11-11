-- Frozen WrathBench 0.5 run.sqlite: the schema as the 0.5 writer created it (its comments left out), then every row in rowid order.
-- Generated once at WrathBench f61e391d. Never regenerate from newer code.
BEGIN;
CREATE TABLE run (
  run_id TEXT PRIMARY KEY,
  harness_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  driver TEXT,
  shakeout TEXT,
  model TEXT,
  objective TEXT,
  character TEXT,
  platform TEXT,
  resolved_model TEXT,
  resolved_cli_version TEXT,
  resolved_provider TEXT,
  continued_from TEXT,
  termination_reason TEXT,
  termination_detail TEXT,
  pause_reason TEXT,
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
  money INTEGER,
  quests_completed INTEGER,
  turn INTEGER,
  zone INTEGER,
  area INTEGER
, items TEXT, health INTEGER, max_health INTEGER, power INTEGER, max_power INTEGER, power_type INTEGER, next_level_xp INTEGER);
CREATE TABLE move (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  move_id INTEGER,
  map INTEGER,
  x REAL, y REAL, z REAL,
  target TEXT,
  status TEXT
);
CREATE TABLE trace (
  run_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  map INTEGER, x REAL, y REAL, z REAL, o REAL,
  data TEXT
);
CREATE INDEX trace_run_ts ON trace(run_id, ts);
CREATE TABLE trace_dict (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, id)
);
INSERT INTO run (rowid, run_id, harness_version, started_at, ended_at, driver, shakeout, model, objective, character, platform, resolved_model, resolved_cli_version, resolved_provider, continued_from, termination_reason, termination_detail, pause_reason, reflecting_since, config_json) VALUES (1, 'l05-freeplay-2', 'harness-0.5-912-gf61e391d', 1760086500000, NULL, 'openai', NULL, 'fixture/model-two', NULL, 'Quillfeather', 'acme.invalid', 'fixture/model-two-0815', NULL, 'AcmeCloud', 'l05-freeplay-1', NULL, NULL, NULL, 1760087118000, '{"moduleUrl":"http://worldserver:8086","character":"Quillfeather","continuedFrom":"l05-freeplay-1","account":"FIXFREE1","race":4,"class":11,"driver":"openai","model":"fixture/model-two","apiBase":"https://api.acme.invalid/v1","apiKeyEnv":"ACME_KEY","wikiCoords":false,"wiki":true,"extra":false,"episode":"freeplay","maxToolCallsPerEpisode":500,"stepIntervalMs":3000,"stateIntervalMs":60000,"snippetTimeoutMs":30000,"sandboxPingGraceMs":2000,"runsDir":"data/runs","wikiBundle":"data/wiki/bundle.sqlite","watchdogs":{"idleMs":1200000,"noXpMs":null,"episodeMs":null,"maxSandboxRestarts":3},"runId":"l05-freeplay-2"}');
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (1, 'l05-freeplay-2', 1760086520000, 2, 75, 7105, 600, 660, 12, 25, 25, 29, 0, 1, 8901, 8902, '[{"name":"Bent Willow Rod","count":1,"equipped":true,"itemId":91101,"quality":1,"slot":15},{"name":"Speckled Minnow","count":2,"equipped":false,"itemId":91102,"quality":0,"slot":23,"bag":255}]', 74, 74, 64, 64, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (2, 'l05-freeplay-2', 1760086640000, 2, 90, 7105, 620, 660, 12, 50, 50, 30, 0, 2, 8901, 8902, NULL, 74, 74, 64, 64, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (3, 'l05-freeplay-2', 1760086760000, 2, 105, 7105, 640, 660, 12, 75, 75, 31, 0, 3, 8901, 8902, NULL, 74, 74, 64, 64, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (4, 'l05-freeplay-2', 1760086880000, 2, 120, 7105, 660, 660, 12, 100, 100, 32, 1, 4, 8901, 8902, '[{"name":"Bent Willow Rod","count":1,"equipped":true,"itemId":91101,"quality":1,"slot":15},{"name":"Speckled Minnow","count":4,"equipped":false,"itemId":91102,"quality":0,"slot":23,"bag":255}]', 74, 74, 64, 64, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (5, 'l05-freeplay-2', 1760087000000, 2, 135, 7105, 680, 660, 12, 125, 125, 33, 1, 5, 8901, 8902, NULL, 74, 74, 64, 64, 0, 400);
INSERT INTO move (rowid, run_id, ts, move_id, map, x, y, z, target, status) VALUES (1, 'l05-freeplay-2', 1760087110000, 711, 7105, 800, 660, 12, NULL, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (1, 'l05-freeplay-2', 1760086503000, 'key', 7105, 580, 660, 12, 0.5, '{"hp":74,"hpMax":74,"pw":64,"pwMax":64,"pwType":0,"level":2,"xp":60,"xpMax":400,"auras":[],"combat":false,"mounted":false,"taxi":false,"dead":false,"ghost":false,"resting":false,"target":null,"cast":null,"money":28,"equip":[[15,91101]],"bags":[],"inv":[[255,23,91102,2]],"dur":[[15,20,20]],"quests":[[0,92101,0]],"rep":[],"skills":[[95101,12,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (2, 'l05-freeplay-2', 1760086505000, 'pos', 7105, 585, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (3, 'l05-freeplay-2', 1760086520000, 'pos', 7105, 590, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (4, 'l05-freeplay-2', 1760086535000, 'pos', 7105, 595, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (5, 'l05-freeplay-2', 1760086550000, 'pos', 7105, 600, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (6, 'l05-freeplay-2', 1760086565000, 'pos', 7105, 605, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (7, 'l05-freeplay-2', 1760086580000, 'pos', 7105, 610, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (8, 'l05-freeplay-2', 1760086595000, 'pos', 7105, 615, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (9, 'l05-freeplay-2', 1760086600000, 'state', NULL, NULL, NULL, NULL, NULL, '{"inv":[[255,23,91102,3]],"chat":[["say","Nice catch!"]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (10, 'l05-freeplay-2', 1760086610000, 'pos', 7105, 620, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (11, 'l05-freeplay-2', 1760086625000, 'pos', 7105, 625, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (12, 'l05-freeplay-2', 1760086640000, 'pos', 7105, 630, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (13, 'l05-freeplay-2', 1760086655000, 'pos', 7105, 635, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (14, 'l05-freeplay-2', 1760086670000, 'pos', 7105, 640, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (15, 'l05-freeplay-2', 1760086685000, 'pos', 7105, 645, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (16, 'l05-freeplay-2', 1760086700000, 'pos', 7105, 650, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (17, 'l05-freeplay-2', 1760086715000, 'pos', 7105, 655, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (18, 'l05-freeplay-2', 1760086730000, 'pos', 7105, 660, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (19, 'l05-freeplay-2', 1760086745000, 'pos', 7105, 665, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (20, 'l05-freeplay-2', 1760086760000, 'pos', 7105, 670, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (21, 'l05-freeplay-2', 1760086775000, 'pos', 7105, 675, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (22, 'l05-freeplay-2', 1760086790000, 'pos', 7105, 680, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (23, 'l05-freeplay-2', 1760086800000, 'key', 7105, 680, 660, 12, 0, '{"hp":74,"hpMax":74,"pw":64,"pwMax":64,"pwType":0,"level":2,"xp":60,"xpMax":400,"auras":[],"combat":false,"mounted":false,"taxi":false,"dead":false,"ghost":false,"resting":false,"target":null,"cast":null,"money":28,"equip":[[15,91101]],"bags":[],"inv":[[255,23,91102,3]],"dur":[[15,20,20]],"quests":[[0,92101,0]],"rep":[],"skills":[[95101,12,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (24, 'l05-freeplay-2', 1760086805000, 'pos', 7105, 685, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (25, 'l05-freeplay-2', 1760086820000, 'pos', 7105, 690, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (26, 'l05-freeplay-2', 1760086835000, 'pos', 7105, 695, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (27, 'l05-freeplay-2', 1760086850000, 'pos', 7105, 700, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (28, 'l05-freeplay-2', 1760086865000, 'pos', 7105, 705, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (29, 'l05-freeplay-2', 1760086880000, 'pos', 7105, 710, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (30, 'l05-freeplay-2', 1760086895000, 'pos', 7105, 715, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (31, 'l05-freeplay-2', 1760086900000, 'state', NULL, NULL, NULL, NULL, NULL, '{"inv":[[255,23,91102,5]],"skills":[[95101,14,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (32, 'l05-freeplay-2', 1760086910000, 'pos', 7105, 720, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (33, 'l05-freeplay-2', 1760086925000, 'pos', 7105, 725, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (34, 'l05-freeplay-2', 1760086940000, 'pos', 7105, 730, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (35, 'l05-freeplay-2', 1760086955000, 'pos', 7105, 735, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (36, 'l05-freeplay-2', 1760086970000, 'pos', 7105, 740, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (37, 'l05-freeplay-2', 1760086985000, 'pos', 7105, 745, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (38, 'l05-freeplay-2', 1760087000000, 'pos', 7105, 750, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (39, 'l05-freeplay-2', 1760087015000, 'pos', 7105, 755, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (40, 'l05-freeplay-2', 1760087030000, 'pos', 7105, 760, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (41, 'l05-freeplay-2', 1760087045000, 'pos', 7105, 765, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (42, 'l05-freeplay-2', 1760087060000, 'pos', 7105, 770, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (43, 'l05-freeplay-2', 1760087075000, 'pos', 7105, 775, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (44, 'l05-freeplay-2', 1760087090000, 'pos', 7105, 780, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (45, 'l05-freeplay-2', 1760087100000, 'key', 7105, 780, 660, 12, 0, '{"hp":74,"hpMax":74,"pw":64,"pwMax":64,"pwType":0,"level":2,"xp":60,"xpMax":400,"auras":[],"combat":false,"mounted":false,"taxi":false,"dead":false,"ghost":false,"resting":false,"target":null,"cast":null,"money":28,"equip":[[15,91101]],"bags":[],"inv":[[255,23,91102,5]],"dur":[[15,20,20]],"quests":[[0,92101,0]],"rep":[],"skills":[[95101,14,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (46, 'l05-freeplay-2', 1760087105000, 'pos', 7105, 785, 660, 12, 0, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (47, 'l05-freeplay-2', 1760087110000, 'state', NULL, NULL, NULL, NULL, NULL, '{"target":{"kind":"player"},"resting":true}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (48, 'l05-freeplay-2', 1760087120000, 'pos', 7105, 790, 660, 12, 0, NULL);
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (1, 'l05-freeplay-2', 'item', 91101, '[1,"Bent Willow Rod"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (2, 'l05-freeplay-2', 'item', 91102, '[0,"Speckled Minnow"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (3, 'l05-freeplay-2', 'quest', 92101, '[0,0,0,0,91102,6]');
COMMIT;
