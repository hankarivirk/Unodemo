-- UNO Royale / Matcho! PostgreSQL & SQLite Compatible Schema

CREATE TABLE IF NOT EXISTS players (
  id VARCHAR(64) PRIMARY KEY,
  first_name VARCHAR(128) NOT NULL,
  username VARCHAR(128) DEFAULT '',
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id VARCHAR(64) PRIMARY KEY,
  host_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'waiting', -- 'waiting', 'playing', 'finished', 'expired'
  state_version INTEGER NOT NULL DEFAULT 1,
  inline_message_id VARCHAR(128) DEFAULT NULL,
  chat_id VARCHAR(64) DEFAULT NULL,
  message_id VARCHAR(64) DEFAULT NULL,
  players_json TEXT NOT NULL,
  spectators_json TEXT NOT NULL,
  match_state_json TEXT DEFAULT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id VARCHAR(64) PRIMARY KEY,
  room_id VARCHAR(64) NOT NULL,
  winner_id VARCHAR(64) NOT NULL,
  win_score INTEGER NOT NULL DEFAULT 0,
  players_summary_json TEXT NOT NULL,
  completed_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_status_expires ON rooms(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_matches_room_id ON matches(room_id);
CREATE INDEX IF NOT EXISTS idx_players_wins ON players(wins DESC);
