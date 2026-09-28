const { EmbedBuilder, Colors, ActivityType, escapeMarkdown } = require('discord.js');
const { db } = require('./db');

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
      await post(channel, Colors.Red, '🔴 Server is offline', 'Everyone was marked as left. I will post again when it is back.');
    }
    return;
  }

  const wasOffline = s.online === false;
  Object.assign(s, { online: true, failures: 0, info: data.info });
  if (wasOffline) {
    await post(channel, Colors.Green, '🟢 Server is back online', `${data.info.clients}/${data.info.sv_maxclients} players`);
  }

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
    await post(channel, Colors.Green, `🟩 ${joined.length} joined`, listLines(joined.map(([, p]) => escapeMarkdown(p.name))));
  }
  if (left.length) {
    await post(channel, Colors.Red, `🟥 ${left.length} left`,
      listLines(left.map((row) => `${escapeMarkdown(row.name)} · played ${formatDuration(now - row.joined_at)}`)));
  }
}

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
};
