const { EmbedBuilder, Colors, ActivityType, escapeMarkdown } = require('discord.js');
const { db, getSettings, getFeature } = require('./db');

const POLL_MS = 10_000;
const OFFLINE_AFTER_FAILURES = 3;
const LIST_LIMIT = 25;

// guildId -> { online, failures, info }
const state = new Map();

// Accepts "1.2.3.4", "1.2.3.4:30120" or a full URL. Bare hosts get FiveM's default port.
function normalizeServerUrl(input) {
  try {
    const hasScheme = /^https?:\/\//i.test(input);
    const url = new URL(hasScheme ? input : `http://${input}`);
    if (!hasScheme && !url.port) url.port = '30120';
    return url.origin;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchServer(baseUrl) {
  const [players, info] = await Promise.all([
    fetchJson(`${baseUrl}/players.json`),
    fetchJson(`${baseUrl}/dynamic.json`),
  ]);
  if (!Array.isArray(players)) throw new Error('players.json is not a list');
  return { players, info };
}

// FiveM server ids get reused, the license identifier does not.
const playerKey = (p) => p.identifiers?.find((id) => id.startsWith('license:')) ?? `name:${p.name}`;
const discordIdOf = (p) => p.identifiers?.find((id) => id.startsWith('discord:'))?.slice('discord:'.length) ?? null;

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function listLines(lines) {
  const rest = lines.length - LIST_LIMIT;
  return lines.slice(0, LIST_LIMIT).join('\n') + (rest > 0 ? `\n…and ${rest} more` : '');
}

const openSessions = (guildId) =>
  db.prepare('SELECT * FROM sessions WHERE guild_id = ? AND left_at IS NULL ORDER BY joined_at').all(guildId);

const closeSessions = (guildId, at) =>
  db.prepare('UPDATE sessions SET left_at = ? WHERE guild_id = ? AND left_at IS NULL').run(at, guildId);

const post = (channel, color, title, description) =>
  channel?.send({
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description || null).setTimestamp()],
  }).catch((e) => console.error(`Monitor post failed: ${e.message}`));

async function pollGuild(client, settings) {
  const guildId = settings.guild_id;
  const channel = client.channels.cache.get(settings.monitor_channel_id);
  const s = state.get(guildId) ?? { online: null, failures: 0 };
  state.set(guildId, s);

  let data;
  try {
    data = await fetchServer(settings.server_url);
  } catch {
    // A few misses in a row means offline; one miss is usually a hiccup.
    if (++s.failures === OFFLINE_AFTER_FAILURES) {
      s.online = false;
      closeSessions(guildId, Date.now());
      await post(channel, Colors.Red, 'Server is offline', 'Everyone was marked as left. I will post again when it is back.');
      await renameCountChannel(client, guildId, s, 'Server offline', true);
    }
    return;
  }

  const wasOffline = s.online === false;
  Object.assign(s, { online: true, failures: 0, info: data.info });
  if (wasOffline) {
    await post(channel, Colors.Green, 'Server is back online', `${data.info.clients}/${data.info.sv_maxclients} players`);
  }
  recordCount(guildId, s, data.players.length);
  await renameCountChannel(client, guildId, s, `Players: ${data.info.clients}/${data.info.sv_maxclients}`);

  // ponytail: sessions still open from before a bot restart count the downtime as playtime.
  const now = Date.now();
  const open = new Map(openSessions(guildId).map((row) => [row.player_key, row]));
  const current = new Map(data.players.map((p) => [playerKey(p), p]));
  const joined = [...current].filter(([key]) => !open.has(key));
  const left = [...open.values()].filter((row) => !current.has(row.player_key));

  const insert = db.prepare('INSERT INTO sessions (guild_id, player_key, name, discord_id, joined_at) VALUES (?, ?, ?, ?, ?)');
  for (const [key, p] of joined) insert.run(guildId, key, p.name, discordIdOf(p), now);
  const close = db.prepare('UPDATE sessions SET left_at = ? WHERE id = ?');
  for (const row of left) close.run(now, row.id);

  if (joined.length) {
    await post(channel, Colors.Green, `${joined.length} joined`, listLines(joined.map(([, p]) => escapeMarkdown(p.name))));
    await alertWatched(client, guildId, joined);
  }
  if (left.length) {
    await post(channel, Colors.Red, `${left.length} left`,
      listLines(left.map((row) => `${escapeMarkdown(row.name)} · played ${formatDuration(now - row.joined_at)}`)));
  }
}

// Stores the player count every 5 minutes for the 24-hour chart; a week of history is kept.
const HISTORY_EVERY_MS = 5 * 60_000;
function recordCount(guildId, s, count, now = Date.now()) {
  if (now - (s.lastRecorded ?? 0) < HISTORY_EVERY_MS) return;
  s.lastRecorded = now;
  db.prepare('INSERT INTO player_counts (guild_id, at, count) VALUES (?, ?, ?)').run(guildId, now, count);
  db.prepare('DELETE FROM player_counts WHERE guild_id = ? AND at < ?').run(guildId, now - 7 * 86_400_000);
}

// Hourly peaks for the last 24 hours as a text sparkline, oldest first.
function last24h(guildId, now = Date.now()) {
  const HOUR = 3_600_000;
  const rows = db.prepare('SELECT at, count FROM player_counts WHERE guild_id = ? AND at > ?').all(guildId, now - 24 * HOUR);
  const buckets = Array(24).fill(null);
  let peak = { count: 0, at: null };
  for (const { at, count } of rows) {
    const index = 23 - Math.floor((now - at) / HOUR);
    buckets[index] = Math.max(buckets[index] ?? 0, count);
    if (count >= peak.count) peak = { count, at };
  }
  const bars = '▁▂▃▄▅▆▇█';
  const spark = buckets.map((v) => (v === null ? '·' : bars[peak.count ? Math.round((v / peak.count) * 7) : 0])).join('');
  return { spark, peak, samples: rows.length };
}

// A voice channel whose name shows the live count. Discord allows 2 renames per 10 minutes.
const RENAME_EVERY_MS = 5 * 60_000;
async function renameCountChannel(client, guildId, s, name, force = false) {
  const { countChannelId } = getFeature(guildId, 'fivem', {});
  const channel = countChannelId && client.channels.cache.get(countChannelId);
  if (!channel || channel.name === name) return;
  if (!force && Date.now() - (s.lastRename ?? 0) < RENAME_EVERY_MS) return;
  s.lastRename = Date.now();
  await channel.setName(name, 'Player count').catch(() => {});
}

// Pings staff in the mod log when someone on the watchlist joins the game server.
async function alertWatched(client, guildId, joined) {
  const entries = db.prepare('SELECT * FROM watchlist WHERE guild_id = ?').all(guildId);
  if (!entries.length) return;
  const hits = [];
  for (const [key, p] of joined) {
    const ids = [p.name.toLowerCase(), key.toLowerCase(), discordIdOf(p)].filter(Boolean);
    const entry = entries.find((e) => ids.includes(e.player.toLowerCase()));
    if (entry) hits.push(`**${escapeMarkdown(p.name)}**${discordIdOf(p) ? ` (<@${discordIdOf(p)}>)` : ''}${entry.note ? ` · ${escapeMarkdown(entry.note)}` : ''}`);
  }
  if (!hits.length) return;
  const modlog = client.channels.cache.get(getSettings(guildId).modlog_channel_id);
  await modlog?.send({
    content: '@here',
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle('Watched player joined the game server').setDescription(hits.join('\n')).setTimestamp()],
    allowedMentions: { parse: ['everyone'] },
  }).catch(() => {});
}

// Watchlist entries match an in-game name, a license identifier or a Discord user.
const watchKey = (text) => (text.match(/^<@!?(\d+)>$/)?.[1] ?? text).trim();

let lastPresence;
function updatePresence(client, monitored) {
  const online = monitored.map((g) => state.get(g.guild_id)).filter((s) => s?.online);
  const text = online.length === 1
    ? `${online[0].info.clients}/${online[0].info.sv_maxclients} players`
    : 'over the server';
  if (text === lastPresence) return;
  lastPresence = text;
  client.user.setActivity(text, { type: ActivityType.Watching });
}

async function poll(client) {
  const monitored = db.prepare('SELECT * FROM guild_settings WHERE server_url IS NOT NULL').all()
    .filter((g) => client.guilds.cache.has(g.guild_id));
  for (const settings of monitored) {
    await pollGuild(client, settings).catch((e) => console.error(`Monitor ${settings.guild_id}:`, e));
  }
  updatePresence(client, monitored);
  setTimeout(() => poll(client), POLL_MS);
}

// Called when a guild changes or turns off its server, so old sessions don't linger.
function resetGuild(guildId) {
  state.delete(guildId);
  closeSessions(guildId, Date.now());
}

module.exports = {
  start: poll, resetGuild, fetchServer, normalizeServerUrl, formatDuration, listLines, playerKey, openSessions,
  recordCount, last24h, watchKey,
};
