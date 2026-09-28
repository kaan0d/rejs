const { EmbedBuilder, Colors } = require('discord.js');
const { db, getSettings } = require('./db');
const { formatDuration } = require('./monitor');

const MAX_TIMEOUT_MS = 28 * 86_400_000;
const ABLE = { warn: () => true, timeout: (m) => m.moderatable, kick: (m) => m.kickable, ban: (m) => m.bannable };

// Returns why the moderator (or the bot) can't act on this member, or null when they can.
function checkTarget(moderator, member, action) {
  if (!member) return 'That user is not in this server.';
  const { guild } = member;
  if (member.id === moderator.id) return `You can't ${action} yourself.`;
  if (member.id === guild.members.me.id) return `I can't ${action} myself.`;
  if (member.id === guild.ownerId) return `You can't ${action} the server owner.`;
  if (moderator.id !== guild.ownerId && member.roles.highest.position >= moderator.roles.highest.position) {
    return `${member} has a role equal to or higher than yours.`;
  }
  if (!ABLE[action](member)) return `I can't ${action} ${member}. My role must be above theirs and I need the permission.`;
  return null;
}

// Audit log entry for Discord's own audit log.
const auditReason = (moderator, reason) => `${moderator.user?.tag ?? moderator.tag}: ${reason}`.slice(0, 512);

async function modLog(guild, { title, color, target, moderator, reason, extra }) {
  const { modlog_channel_id } = getSettings(guild.id);
  const channel = modlog_channel_id && guild.channels.cache.get(modlog_channel_id);
  if (!channel) return;
  const lines = [
    target && `**User:** ${target} (\`${target.id}\`)`,
    `**Moderator:** ${moderator}`,
    reason && `**Reason:** ${reason}`,
    extra,
  ].filter(Boolean);
  await channel.send({
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join('\n')).setTimestamp()],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

// Best effort: members with DMs closed just don't get told.
const notify = (user, text) => user.send(text).catch(() => {});

const addWarning = (guildId, userId, moderatorId, reason) => {
  db.prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(guildId, userId, moderatorId, reason, Date.now());
  return db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ?').get(guildId, userId).n;
};

// Applies the server's warning thresholds. Returns what happened, or null.
async function escalate(member, count, moderator) {
  const s = getSettings(member.guild.id);
  const reason = `Reached ${count} warnings`;
  if (s.warn_kick_at && count >= s.warn_kick_at && member.kickable) {
    await notify(member.user, `👢 You were kicked from **${member.guild.name}** after ${count} warnings.`);
    await member.kick(auditReason(moderator, reason));
    await modLog(member.guild, { title: '👢 Auto-kick', color: Colors.Orange, target: member.user, moderator, reason });
    return `Kicked automatically (${count} warnings).`;
  }
  if (s.warn_timeout_at && count >= s.warn_timeout_at && member.moderatable) {
    const ms = s.warn_timeout_ms ?? 3_600_000;
    await member.timeout(ms, auditReason(moderator, reason));
    await modLog(member.guild, { title: '🔇 Auto-timeout', color: Colors.Orange, target: member.user, moderator, reason, extra: `**Duration:** ${formatDuration(ms)}` });
    return `Timed out automatically for ${formatDuration(ms)} (${count} warnings).`;
  }
  return null;
}

// Pulls user IDs out of free text, so pasted lists and mentions both work.
const parseIds = (text) => [...new Set(String(text).match(/\d{17,20}/g) ?? [])];

module.exports = { MAX_TIMEOUT_MS, checkTarget, auditReason, modLog, notify, addWarning, escalate, parseIds };
