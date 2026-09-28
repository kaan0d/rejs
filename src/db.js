const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_PATH ?? 'rejs.db');

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    server_url TEXT,
    monitor_channel_id TEXT,
    levelup_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS levels (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    xp INTEGER NOT NULL,
    thanks INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS level_roles (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    discord_id TEXT,
    joined_at INTEGER NOT NULL,
    left_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS sessions_by_guild ON sessions (guild_id, left_at);
`);

const getSettings = (guildId) =>
  db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) ?? {};

// Column names come from code, never from user input.
const setSetting = (guildId, column, value) =>
  db.prepare(`
    INSERT INTO guild_settings (guild_id, ${column}) VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET ${column} = excluded.${column}
  `).run(guildId, value);

module.exports = { db, getSettings, setSetting };
