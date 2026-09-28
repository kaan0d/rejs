const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_PATH ?? 'rejs.db');

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    server_url TEXT,
    monitor_channel_id TEXT
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

  -- Every moderation action and staff note. "active" is cleared when a warning is removed
  -- or a temporary ban is lifted.
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    action TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_tag TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    duration_ms INTEGER,
    expires_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (guild_id, number)
  );
  CREATE INDEX IF NOT EXISTS cases_by_user ON cases (guild_id, user_id);
  CREATE INDEX IF NOT EXISTS cases_expiring ON cases (expires_at) WHERE expires_at IS NOT NULL AND active = 1;

  CREATE TABLE IF NOT EXISTS reasons (
    guild_id TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (guild_id, text)
  );

  CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    case_number INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    UNIQUE (guild_id, case_number)
  );

  CREATE TABLE IF NOT EXISTS log_ignores (
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (guild_id, target_id)
  );

  -- One JSON settings blob per protection feature, so new options need no schema change.
  CREATE TABLE IF NOT EXISTS features (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    claimed_by TEXT,
    rating INTEGER,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    warned_at INTEGER,
    closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS tickets_open ON tickets (status, guild_id, user_id);

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    channel_id TEXT,
    message_id TEXT,
    content TEXT,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    handled_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_menus (
    message_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    max_choices INTEGER NOT NULL,
    roles TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    user_id TEXT NOT NULL,
    anonymous INTEGER NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    status_reason TEXT,
    handled_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS suggestion_votes (
    suggestion_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    vote INTEGER NOT NULL,
    PRIMARY KEY (suggestion_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS responders (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    response TEXT NOT NULL,
    channels TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS tags (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS stickies (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    content TEXT NOT NULL,
    message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    dm INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS giveaways (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    host_id TEXT NOT NULL,
    prize TEXT NOT NULL,
    winners INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    required_role TEXT,
    min_age_ms INTEGER,
    ended INTEGER NOT NULL DEFAULT 0,
    winner_ids TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS temp_voice (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    owner_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS player_counts (
    guild_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS player_counts_by_time ON player_counts (guild_id, at);

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    player TEXT NOT NULL,
    note TEXT,
    added_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    guild_id TEXT PRIMARY KEY,
    reason TEXT,
    added_at INTEGER NOT NULL
  );

  -- When the bot left a server; its data is deleted 30 days later unless it comes back.
  CREATE TABLE IF NOT EXISTS departed_guilds (
    guild_id TEXT PRIMARY KEY,
    left_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS command_usage (
    name TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message TEXT NOT NULL,
    interval_ms INTEGER NOT NULL,
    next_run_at INTEGER NOT NULL
  );
`);

// Settings added after the first release. ADD COLUMN fails once the column exists, which is fine.
for (const column of [
  'modlog_channel_id TEXT',
  'autorole_id TEXT',
  'warn_timeout_at INTEGER',
  'warn_timeout_ms INTEGER',
  'warn_kick_at INTEGER',
  'warn_expiry_ms INTEGER',
  'appeals_channel_id TEXT',
  'message_log_id TEXT',
  'member_log_id TEXT',
  'voice_log_id TEXT',
]) {
  try { db.exec(`ALTER TABLE guild_settings ADD COLUMN ${column}`); } catch {}
}

const getSettings = (guildId) =>
  db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) ?? {};

// Column names come from code, never from user input.
const setSetting = (guildId, column, value) =>
  db.prepare(`
    INSERT INTO guild_settings (guild_id, ${column}) VALUES (?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET ${column} = excluded.${column}
  `).run(guildId, value);

// Feature settings merged over their defaults, so older saved settings pick up new options.
function getFeature(guildId, name, defaults = {}) {
  const row = db.prepare('SELECT config FROM features WHERE guild_id = ? AND name = ?').get(guildId, name);
  return { ...defaults, ...(row ? JSON.parse(row.config) : {}) };
}

const setFeature = (guildId, name, config) =>
  db.prepare(`
    INSERT INTO features (guild_id, name, config) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, name) DO UPDATE SET config = excluded.config
  `).run(guildId, name, JSON.stringify(config));

module.exports = { db, getSettings, setSetting, getFeature, setFeature };
