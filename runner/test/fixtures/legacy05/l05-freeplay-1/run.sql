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
INSERT INTO run (rowid, run_id, harness_version, started_at, ended_at, driver, shakeout, model, objective, character, platform, resolved_model, resolved_cli_version, resolved_provider, continued_from, termination_reason, termination_detail, pause_reason, reflecting_since, config_json) VALUES (1, 'l05-freeplay-1', 'harness-0.5-610-g1a2b3c4d', 1759827330000, 1759827870000, 'openai', NULL, 'fixture/model-two', NULL, 'Quillfeather', 'acme.invalid', NULL, NULL, NULL, NULL, 'manual', 'operator disabled the stream', NULL, NULL, '{"moduleUrl":"http://worldserver:8086","character":"Quillfeather","account":"FIXFREE1","race":4,"class":11,"driver":"openai","model":"fixture/model-two","apiBase":"https://api.acme.invalid/v1","apiKeyEnv":"ACME_KEY","wikiCoords":false,"wiki":true,"extra":false,"episode":"freeplay","maxToolCallsPerEpisode":500,"stepIntervalMs":3000,"stateIntervalMs":60000,"snippetTimeoutMs":30000,"sandboxPingGraceMs":2000,"runsDir":"data/runs","wikiBundle":"data/wiki/bundle.sqlite","watchdogs":{"idleMs":1200000,"noXpMs":null,"episodeMs":null,"maxSandboxRestarts":3},"runId":"l05-freeplay-1"}');
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (1, 'l05-freeplay-1', 1759827332000, 1, 90, 7105, 520, 690, 12, 30, 30, 7, 0, 1, 8901, 8902, NULL, 61, 70, 50, 60, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (2, 'l05-freeplay-1', 1759827452000, 1, 180, 7105, 540, 680, 12, 60, 60, 14, 0, 2, 8901, 8902, NULL, 62, 70, 50, 60, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (3, 'l05-freeplay-1', 1759827572000, 2, 270, 7105, 560, 670, 12, 90, 90, 21, 1, 3, 8901, 8902, NULL, 63, 70, 50, 60, 0, 400);
INSERT INTO state (rowid, run_id, ts, level, xp, map, x, y, z, event_count, last_seq, money, quests_completed, turn, zone, area, items, health, max_health, power, max_power, power_type, next_level_xp) VALUES (4, 'l05-freeplay-1', 1759827692000, 2, 360, 7105, 580, 660, 12, 120, 120, 28, 1, 4, 8901, 8902, NULL, 64, 70, 50, 60, 0, 400);
COMMIT;
