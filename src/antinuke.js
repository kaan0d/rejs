const { EmbedBuilder, Colors, AuditLogEvent, Events } = require('discord.js');
const { getFeature, getSettings } = require('./db');

const DEFAULTS = { enabled: false, limit: 3, seconds: 10 };
const WATCHED = {
  [AuditLogEvent.MemberBanAdd]: 'ban',
  [AuditLogEvent.MemberKick]: 'kick',
  [AuditLogEvent.ChannelDelete]: 'channel delete',
  [AuditLogEvent.RoleDelete]: 'role delete',
};

// `${guildId}:${userId}` -> recent destructive actions [{ at, kind }]
const recent = new Map();

// Counts destructive actions per account. Returns the actions once the limit is reached.
function track(guildId, executorId, kind, cfg, now = Date.now()) {
  const key = `${guildId}:${executorId}`;
  const list = (recent.get(key) ?? []).filter((a) => now - a.at < cfg.seconds * 1000);
  list.push({ at: now, kind });
  if (list.length < cfg.limit) {
    recent.set(key, list);
    return null;
  }
  recent.delete(key);
  return list;
}

async function onAuditEntry(entry, guild) {
  const kind = WATCHED[entry.action];
  if (!kind || !entry.executorId) return;
  const cfg = getFeature(guild.id, 'antinuke', DEFAULTS);
  // The owner can't be stopped anyway; the bot's own actions come from commands staff already confirmed.
  if (!cfg.enabled || entry.executorId === guild.ownerId || entry.executorId === guild.members.me.id) return;

  const actions = track(guild.id, entry.executorId, kind, cfg);
  if (!actions) return;

  const member = await guild.members.fetch(entry.executorId).catch(() => null);
  // Integration roles can't be removed, so those stay.
  const stripped = member && await member.roles.set(member.roles.cache.filter((r) => r.managed), 'Anti-nuke: too many destructive actions')
    .then(() => true, () => false);

  const counts = {};
  for (const a of actions) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const what = Object.entries(counts).map(([k, n]) => `${n}× ${k}`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle('Anti-nuke triggered')
    .setDescription([
      `<@${entry.executorId}> (\`${entry.executorId}\`) did ${what} within ${cfg.seconds} seconds.`,
      stripped
        ? 'Their roles were removed. Check what happened, then give them back if it was legitimate.'
        : '**I could not remove their roles** (their role is above mine, or they are gone). Act now.',
    ].join('\n'))
    .setTimestamp();

  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send({ content: `⚠️ Something happened in **${guild.name}**`, embeds: [embed] }).catch(() => {});
  const channel = guild.channels.cache.get(getSettings(guild.id).modlog_channel_id);
  await channel?.send({ content: '@here', embeds: [embed], allowedMentions: { parse: ['everyone'] } }).catch(() => {});
}

const register = (client) =>
  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => onAuditEntry(entry, guild).catch((e) => console.error('Anti-nuke:', e)));

module.exports = { DEFAULTS, register, track };
