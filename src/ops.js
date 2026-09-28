// Running the bot in many servers: blacklist, data cleanup after leaving, usage stats and error reports.
const { EmbedBuilder, Colors, Events } = require('discord.js');
const { db } = require('./db');

const RETENTION_MS = 30 * 86_400_000;
const ERROR_REPEAT_MS = 10 * 60_000;

// ---- Blacklist ------------------------------------------------------------------------------

const isBlacklisted = (guildId) => Boolean(db.prepare('SELECT 1 FROM blacklist WHERE guild_id = ?').get(guildId));

async function blacklist(client, guildId, reason) {
  db.prepare('INSERT OR REPLACE INTO blacklist (guild_id, reason, added_at) VALUES (?, ?, ?)').run(guildId, reason, Date.now());
  const guild = client.guilds.cache.get(guildId);
  await guild?.leave().catch(() => {});
  return guild?.name ?? null;
}

const unblacklist = (guildId) => db.prepare('DELETE FROM blacklist WHERE guild_id = ?').run(guildId).changes > 0;

// ---- Data retention -------------------------------------------------------------------------

// Every table with a guild_id column, read from the schema so new tables are covered too.
const guildTables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  .map((t) => t.name)
  .filter((name) => db.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === 'guild_id'))
  .filter((name) => !['blacklist', 'departed_guilds'].includes(name));

function deleteGuildData(guildId) {
  let rows = 0;
  for (const table of guildTables()) rows += db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId).changes;
  // Child rows that point at deleted parents.
  db.exec(`
    DELETE FROM suggestion_votes WHERE suggestion_id NOT IN (SELECT id FROM suggestions);
    DELETE FROM giveaway_entries WHERE giveaway_id NOT IN (SELECT id FROM giveaways);
    DELETE FROM undo_rows WHERE tx NOT IN (SELECT id FROM undo_log);
  `);
  db.prepare('DELETE FROM departed_guilds WHERE guild_id = ?').run(guildId);
  return rows;
}

// Deletes the data of servers the bot left more than 30 days ago. Runs on the scheduler tick.
function purgeDeparted(now = Date.now()) {
  const due = db.prepare('SELECT guild_id FROM departed_guilds WHERE left_at < ?').all(now - RETENTION_MS);
  for (const { guild_id } of due) {
    const rows = deleteGuildData(guild_id);
    console.log(`Deleted data of server ${guild_id} (${rows} rows), 30 days after leaving.`);
  }
  return due.length;
}

// ---- Usage and errors -----------------------------------------------------------------------

const countUsage = (name) =>
  db.prepare('INSERT INTO command_usage (name, count) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1').run(name);

const topCommands = (limit = 10) => db.prepare('SELECT name, count FROM command_usage ORDER BY count DESC LIMIT ?').all(limit);

const recentErrors = new Map();

// Sends unexpected errors to ERROR_CHANNEL_ID, or to the owner by DM. The same error is
// reported at most once every 10 minutes.
async function reportError(client, context, error) {
  console.error(`${context}:`, error);
  const text = String(error?.stack ?? error).slice(0, 3800);
  const key = `${context}:${String(error?.message ?? error)}`;
  if (Date.now() - (recentErrors.get(key) ?? 0) < ERROR_REPEAT_MS) return;
  recentErrors.set(key, Date.now());
  if (!client?.isReady()) return;

  const embed = new EmbedBuilder().setColor(Colors.Red).setTitle(`💥 ${context}`.slice(0, 256)).setDescription(`\`\`\`\n${text}\n\`\`\``).setTimestamp();
  const channel = process.env.ERROR_CHANNEL_ID && client.channels.cache.get(process.env.ERROR_CHANNEL_ID);
  if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
  else await client.notifyOwner?.({ embeds: [embed] });
}

// ---- Wiring ---------------------------------------------------------------------------------

function register(client) {
  client.on(Events.GuildCreate, async (guild) => {
    if (isBlacklisted(guild.id)) {
      console.log(`Left blacklisted server ${guild.name} (${guild.id}).`);
      return guild.leave().catch(() => {});
    }
    // Came back within 30 days: keep everything.
    db.prepare('DELETE FROM departed_guilds WHERE guild_id = ?').run(guild.id);
  });
  client.on(Events.GuildDelete, (guild) => {
    // Discord also sends this during outages; those servers aren't really gone.
    if (!guild.available) return;
    db.prepare('INSERT OR IGNORE INTO departed_guilds (guild_id, left_at) VALUES (?, ?)').run(guild.id, Date.now());
  });
  client.once(Events.ClientReady, async (c) => {
    for (const guild of c.guilds.cache.values()) {
      if (isBlacklisted(guild.id)) await guild.leave().catch(() => {});
    }
    // Servers that removed the bot while it was offline.
    const now = Date.now();
    const known = new Set(c.guilds.cache.keys());
    for (const { guild_id } of db.prepare('SELECT DISTINCT guild_id FROM guild_settings UNION SELECT DISTINCT guild_id FROM features').all()) {
      if (!known.has(guild_id)) db.prepare('INSERT OR IGNORE INTO departed_guilds (guild_id, left_at) VALUES (?, ?)').run(guild_id, now);
    }
  });
}

module.exports = {
  register, isBlacklisted, blacklist, unblacklist, deleteGuildData, purgeDeparted, countUsage, topCommands, reportError, RETENTION_MS,
};
