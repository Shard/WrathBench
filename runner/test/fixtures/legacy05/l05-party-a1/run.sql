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
INSERT INTO run (rowid, run_id, harness_version, started_at, ended_at, driver, shakeout, model, objective, character, platform, resolved_model, resolved_cli_version, resolved_provider, continued_from, termination_reason, termination_detail, pause_reason, reflecting_since, config_json) VALUES (1, 'l05-party-a1', 'harness-0.5-912-gf61e391d', 1760000110000, 1760000812000, 'openai', NULL, 'fixture/model-one', NULL, 'Brannoch', 'acme.invalid', NULL, NULL, NULL, NULL, 'kill-target', 'the Hollow Regent fell to the party', NULL, NULL, '{"moduleUrl":"http://worldserver:8086","character":"Brannoch","account":"FIXPARTY1","race":3,"class":1,"driver":"openai","model":"fixture/model-one","apiBase":"https://api.acme.invalid/v1","apiKeyEnv":"ACME_KEY","wikiCoords":false,"wiki":true,"extra":false,"campaign":"l05-delve","cell":"trio","campaignVersion":2,"arm":"base","ref":"fixture/model-one@delve","party":{"id":"l05-party","member":"a1","role":"tank","size":3,"members":[{"member":"a1","role":"tank","runId":"l05-party-a1","account":"FIXPARTY1","character":"Brannoch"},{"member":"a2","role":"healer","runId":"l05-party-a2","account":"FIXPARTY2","character":"Ysolde"},{"member":"a3","role":"damage","runId":"l05-party-a3","account":"FIXPARTY3","character":"Tarnwick"}]},"episode":"probing","maxToolCallsPerEpisode":500,"stepIntervalMs":3000,"stateIntervalMs":60000,"snippetTimeoutMs":30000,"sandboxPingGraceMs":2000,"runsDir":"data/runs","wikiBundle":"data/wiki/bundle.sqlite","watchdogs":{"idleMs":1200000,"noXpMs":null,"episodeMs":5400000,"maxSandboxRestarts":3},"runId":"l05-party-a1"}');
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (1, 'l05-party-a1', 1760000112000, 5, 1200, 7101, 1000, 2000, 50, 40, 40, 1520, 0, 1, 8801, 8811, '[{"name":"Fixture Longblade","count":1,"equipped":true,"itemId":91001,"quality":2,"slot":15},{"name":"Pinewood Buckler","count":1,"equipped":true,"itemId":91002,"quality":1,"slot":16},{"name":"Murky Tonic","count":3,"equipped":false,"itemId":91004,"quality":1,"slot":23,"bag":255},{"name":"Matted Pelt","count":2,"equipped":false,"itemId":91005,"quality":0,"slot":0,"bag":19}]', 420, 420, 0, 100, 1, 2800);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (2, 'l05-party-a1', 1760000172000, 5, 1340, 7101, 1077, 2038.5, 50, 95, 95, 1520, 0, 2, 8801, 8811, NULL, 300, 420, 40, 100, 1, 2800);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (3, 'l05-party-a1', 1760000232000, 5, 2700, 7101, 1140, 2010, 50, 160, 160, 1585, 0, 3, 8801, 8811, NULL, 410, 420, 0, 100, 1, 2800);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (4, 'l05-party-a1', 1760000233300, 6, 100, 7101, 1150, 2005, 50, 180, 180, 2085, 1, 3, 8801, 8811, '[{"name":"Band of the Mere","count":1,"equipped":true,"itemId":91006,"quality":3,"slot":15},{"name":"Pinewood Buckler","count":1,"equipped":true,"itemId":91002,"quality":1,"slot":16},{"name":"Murky Tonic","count":3,"equipped":false,"itemId":91004,"quality":1,"slot":23,"bag":255},{"name":"Matted Pelt","count":3,"equipped":false,"itemId":91005,"quality":0,"slot":0,"bag":19}]', 470, 470, 0, 100, 1, 3300);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (5, 'l05-party-a1', 1760000292000, 6, 400, 7101, 1160, 1990, 50, 230, 230, 2085, 1, 4, 8801, 8811, NULL, 0, 470, 0, 100, 1, 3300);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (6, 'l05-party-a1', 1760000412000, 6, 400, 7101, 1180, 2010, 50, 300, 300, 1985, 1, 5, 8801, 8811, NULL, 470, 470, 0, 100, 1, 3300);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (7, 'l05-party-a1', 1760000530000, 6, 900, 7302, 30, 33, -5, 400, 400, 1945, 1, 6, 8850, 8850, NULL, 470, 470, 20, 100, 1, 3300);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (8, 'l05-party-a1', 1760000531550, 6, 1900, 7302, 160, 133, -5, 600, 600, 1945, 1, 6, 8850, 8850, NULL, 470, 470, 0, 100, 1, 3300);
INSERT INTO move (rowid, run_id, ts, move_id, map, x, y, z, target, status) VALUES (1, 'l05-party-a1', 1760000116000, 501, 7101, 1080, 2040, 50, NULL, NULL);
INSERT INTO move (rowid, run_id, ts, move_id, map, x, y, z, target, status) VALUES (2, 'l05-party-a1', 1760000168000, 501, 7101, 1080, 2040, 50, NULL, 'arrived');
INSERT INTO move (rowid, run_id, ts, move_id, map, x, y, z, target, status) VALUES (3, 'l05-party-a1', 1760000711000, 502, 7302, 60, 60, -5, '17379392590251556941', NULL);
INSERT INTO move (rowid, run_id, ts, move_id, map, x, y, z, target, status) VALUES (4, 'l05-party-a1', 1760000713000, 502, 7302, 60, 60, -5, '17379392590251556941', 'too_far');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (1, 'l05-party-a1', 1760000111000, 'key', 7101, 1000, 2000, 50, 1.5, '{"hp":420,"hpMax":420,"pw":0,"pwMax":100,"pwType":1,"level":5,"xp":1200,"xpMax":2800,"auras":[[93001,1,0,19]],"combat":false,"mounted":false,"taxi":false,"dead":false,"ghost":false,"resting":true,"target":null,"cast":null,"money":1520,"equip":[[0,0],[15,91001],[16,91002,-12]],"bags":[[19,91003,6]],"inv":[[255,23,91004,3],[19,0,91005,2]],"dur":[[15,38,40],[16,50,50]],"quests":[[0,92001,0,1],[1,92002,0]],"rep":[[94001,1200]],"skills":[[95001,23,75],[95002,1,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (2, 'l05-party-a1', 1760000115000, 'pos', 7101, 1007, 2003.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (3, 'l05-party-a1', 1760000118000, 'state', NULL, NULL, NULL, NULL, NULL, '{"resting":false,"chat":[["party","Pulling the first warden, stay back."]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (4, 'l05-party-a1', 1760000120000, 'pos', 7101, 1014, 2007, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (5, 'l05-party-a1', 1760000125000, 'pos', 7101, 1021, 2010.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (6, 'l05-party-a1', 1760000130000, 'pos', 7101, 1028, 2014, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (7, 'l05-party-a1', 1760000135000, 'pos', 7101, 1035, 2017.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (8, 'l05-party-a1', 1760000140000, 'pos', 7101, 1042, 2021, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (9, 'l05-party-a1', 1760000145000, 'pos', 7101, 1049, 2024.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (10, 'l05-party-a1', 1760000150000, 'pos', 7101, 1056, 2028, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (11, 'l05-party-a1', 1760000155000, 'pos', 7101, 1063, 2031.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (12, 'l05-party-a1', 1760000160000, 'pos', 7101, 1070, 2035, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (13, 'l05-party-a1', 1760000165000, 'pos', 7101, 1077, 2038.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (14, 'l05-party-a1', 1760000170000, 'pos', 7101, 1081, 2036.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (15, 'l05-party-a1', 1760000174000, 'state', NULL, NULL, NULL, NULL, NULL, '{"combat":true,"target":{"kind":"creature","entry":97001,"hpPct":100},"pw":40}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (16, 'l05-party-a1', 1760000176000, 'state', NULL, NULL, NULL, NULL, NULL, '{"cast":{"spellId":93010,"endsAt":1760000177500},"target":{"kind":"creature","entry":97001,"hpPct":55}}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (17, 'l05-party-a1', 1760000178000, 'state', NULL, NULL, NULL, NULL, NULL, '{"cast":null,"hp":300,"target":{"kind":"creature","entry":97001,"hpPct":0},"quests":[[0,92001,0,2]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (18, 'l05-party-a1', 1760000180000, 'state', NULL, NULL, NULL, NULL, NULL, '{"combat":false,"target":null,"pw":0,"money":1585,"inv":[[19,0,91005,3]],"chat":[["say","One down."]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (19, 'l05-party-a1', 1760000180000, 'pos', 7101, 1085, 2034.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (20, 'l05-party-a1', 1760000190000, 'pos', 7101, 1089, 2032.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (21, 'l05-party-a1', 1760000200000, 'pos', 7101, 1093, 2030.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (22, 'l05-party-a1', 1760000210000, 'pos', 7101, 1097, 2028.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (23, 'l05-party-a1', 1760000220000, 'pos', 7101, 1101, 2026.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (24, 'l05-party-a1', 1760000230000, 'pos', 7101, 1105, 2024.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (25, 'l05-party-a1', 1760000240000, 'pos', 7101, 1109, 2022.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (26, 'l05-party-a1', 1760000234000, 'state', NULL, NULL, NULL, NULL, NULL, '{"quests":[[0]],"qdone":[92001],"money":2085,"xp":2900}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (27, 'l05-party-a1', 1760000235000, 'state', NULL, NULL, NULL, NULL, NULL, '{"level":6,"xp":100,"xpMax":3300,"hpMax":470,"hp":470,"equip":[[15,91006]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (28, 'l05-party-a1', 1760000250000, 'pos', 7101, 1111, 2019.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (29, 'l05-party-a1', 1760000260000, 'pos', 7101, 1113, 2016.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (30, 'l05-party-a1', 1760000270000, 'pos', 7101, 1115, 2013.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (31, 'l05-party-a1', 1760000280000, 'pos', 7101, 1117, 2010.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (32, 'l05-party-a1', 1760000280000, 'state', NULL, NULL, NULL, NULL, NULL, '{"combat":true,"target":{"kind":"creature","entry":97002,"hpPct":80},"hp":120}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (33, 'l05-party-a1', 1760000286000, 'state', NULL, NULL, NULL, NULL, NULL, '{"hp":0,"dead":true,"combat":false,"target":null,"dur":[[15,30,40]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (34, 'l05-party-a1', 1760000288000, 'state', NULL, NULL, NULL, NULL, NULL, '{"ghost":true,"chat":[["party","Died, running back."]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (35, 'l05-party-a1', 1760000288500, 'pos', 7101, 900, 1900, 48, 0.1, '{"jump":1}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (36, 'l05-party-a1', 1760000290000, 'pos', 7101, 1125, 2013.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (37, 'l05-party-a1', 1760000300000, 'pos', 7101, 1133, 2016.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (38, 'l05-party-a1', 1760000310000, 'pos', 7101, 1141, 2019.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (39, 'l05-party-a1', 1760000320000, 'pos', 7101, 1149, 2022.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (40, 'l05-party-a1', 1760000325000, 'state', NULL, NULL, NULL, NULL, NULL, '{"hp":235,"dead":false,"ghost":false}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (41, 'l05-party-a1', 1760000330000, 'pos', 7101, 1150, 2023.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (42, 'l05-party-a1', 1760000340000, 'pos', 7101, 1151, 2024.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (43, 'l05-party-a1', 1760000350000, 'pos', 7101, 1152, 2025.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (44, 'l05-party-a1', 1760000360000, 'pos', 7101, 1153, 2026.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (45, 'l05-party-a1', 1760000370000, 'pos', 7101, 1154, 2027.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (46, 'l05-party-a1', 1760000380000, 'pos', 7101, 1155, 2028.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (47, 'l05-party-a1', 1760000390000, 'pos', 7101, 1156, 2029.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (48, 'l05-party-a1', 1760000400000, 'key', 7101, 1156, 2029.5, 50, 0.75, '{"hp":235,"hpMax":470,"pw":0,"pwMax":100,"pwType":1,"level":6,"xp":100,"xpMax":3300,"auras":[[93001,1,0,19]],"combat":false,"mounted":false,"taxi":false,"dead":false,"ghost":false,"resting":false,"target":null,"cast":null,"money":2085,"equip":[[0,0],[15,91006],[16,91002,-12]],"bags":[[19,91003,6]],"inv":[[19,0,91005,3],[255,23,91004,3]],"dur":[[15,30,40],[16,50,50]],"quests":[[1,92002,0]],"rep":[[94001,1200]],"skills":[[95001,23,75],[95002,1,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (49, 'l05-party-a1', 1760000400000, 'pos', 7101, 1157, 2030.5, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (50, 'l05-party-a1', 1760000415000, 'flight', 7101, 1180, 2010, 50, 2, '{"to":{"map":7101,"x":1700,"y":2600,"z":80},"durationMs":90000}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (51, 'l05-party-a1', 1760000415000, 'state', NULL, NULL, NULL, NULL, NULL, '{"taxi":true,"mounted":true,"money":1945}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (52, 'l05-party-a1', 1760000505000, 'state', NULL, NULL, NULL, NULL, NULL, '{"taxi":false,"mounted":false}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (53, 'l05-party-a1', 1760000505500, 'pos', 7101, 1700, 2600, 80, 2, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (54, 'l05-party-a1', 1760000520000, 'pos', 7302, 10, 20, -5, 3, '{"jump":1}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (55, 'l05-party-a1', 1760000525000, 'pos', 7302, 16, 24, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (56, 'l05-party-a1', 1760000540000, 'pos', 7302, 22, 28, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (57, 'l05-party-a1', 1760000555000, 'pos', 7302, 28, 32, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (58, 'l05-party-a1', 1760000570000, 'pos', 7302, 34, 36, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (59, 'l05-party-a1', 1760000585000, 'pos', 7302, 40, 40, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (60, 'l05-party-a1', 1760000600000, 'pos', 7302, 46, 44, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (61, 'l05-party-a1', 1760000615000, 'pos', 7302, 52, 48, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (62, 'l05-party-a1', 1760000630000, 'pos', 7302, 58, 52, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (63, 'l05-party-a1', 1760000645000, 'pos', 7302, 64, 56, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (64, 'l05-party-a1', 1760000660000, 'pos', 7302, 70, 60, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (65, 'l05-party-a1', 1760000675000, 'pos', 7302, 76, 64, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (66, 'l05-party-a1', 1760000690000, 'pos', 7302, 82, 68, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (67, 'l05-party-a1', 1760000700000, 'key', 7302, 82, 68, 50, 0.75, '{"hp":235,"hpMax":470,"pw":0,"pwMax":100,"pwType":1,"level":6,"xp":100,"xpMax":3300,"auras":[[93001,1,0,19]],"combat":false,"mounted":false,"taxi":false,"dead":false,"ghost":false,"resting":false,"target":null,"cast":null,"money":1945,"equip":[[0,0],[15,91006],[16,91002,-12]],"bags":[[19,91003,6]],"inv":[[19,0,91005,3],[255,23,91004,3]],"dur":[[15,30,40],[16,50,50]],"quests":[[1,92002,0]],"rep":[[94001,1200]],"skills":[[95001,23,75],[95002,1,75]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (68, 'l05-party-a1', 1760000705000, 'pos', 7302, 88, 72, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (69, 'l05-party-a1', 1760000715000, 'state', NULL, NULL, NULL, NULL, NULL, '{"combat":true,"target":{"kind":"creature","entry":97050,"hpPct":100},"auras":[[93001,1,0,19],[93020,2,1760000750000,1]],"chat":[["party","Boss pulled!"],["yell","For the Mere!"]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (70, 'l05-party-a1', 1760000720000, 'pos', 7302, 94, 76, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (71, 'l05-party-a1', 1760000735000, 'pos', 7302, 100, 80, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (72, 'l05-party-a1', 1760000750000, 'pos', 7302, 106, 84, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (73, 'l05-party-a1', 1760000750000, 'state', NULL, NULL, NULL, NULL, NULL, '{"target":{"kind":"creature","entry":97050,"hpPct":0},"auras":[[93001,1,0,19]],"qdone":[]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (74, 'l05-party-a1', 1760000751000, 'state', NULL, NULL, NULL, NULL, NULL, '{"combat":false,"target":null,"inv":[[255,24,91005,1,77]],"skills":[[95002,5,75]],"rep":[[94001,1450]],"chat":[["emote","cheers."],["whisper","thanks for the heals"]]}');
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (75, 'l05-party-a1', 1760000765000, 'pos', 7302, 112, 88, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (76, 'l05-party-a1', 1760000780000, 'pos', 7302, 118, 92, 50, 0.75, NULL);
INSERT INTO trace (rowid, run_id, ts, kind, map, x, y, z, o, data) VALUES (77, 'l05-party-a1', 1760000795000, 'pos', 7302, 124, 96, 50, 0.75, NULL);
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (1, 'l05-party-a1', 'item', 91001, '[2,"Fixture Longblade"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (2, 'l05-party-a1', 'item', 91002, '[1,"Pinewood Buckler"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (3, 'l05-party-a1', 'item', 91003, '[1,"Stitched Satchel"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (4, 'l05-party-a1', 'item', 91004, '[1,"Murky Tonic"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (5, 'l05-party-a1', 'item', 91005, '[0,"Matted Pelt"]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (6, 'l05-party-a1', 'quest', 92001, '[4,0,0,0]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (7, 'l05-party-a1', 'quest', 92002, '[0,0,0,0,91005,5]');
INSERT INTO trace_dict (rowid, run_id, kind, id, data) VALUES (8, 'l05-party-a1', 'item', 91006, '[3,"Band of the Mere"]');
COMMIT;
