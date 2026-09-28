const { EmbedBuilder, Colors, escapeMarkdown } = require('discord.js');
const { db, getSettings } = require('./db');
const { formatDuration } = require('./monitor');
const { BRAND } = require('./util');
const journal = require('./journal');

const MAX_TIMEOUT_MS = 28 * 86_400_000;
const unix = (ms) => Math.floor(ms / 1000);

const ACTIONS = {
  warn: { label: 'Warning', emoji: '⚠️', color: Colors.Yellow },
  timeout: { label: 'Timeout', emoji: '🔇', color: Colors.Orange },
  untimeout: { label: 'Timeout lifted', emoji: '🔊', color: Colors.Green },
  kick: { label: 'Kick', emoji: '👢', color: Colors.Orange },
  softban: { label: 'Softban', emoji: '🧹', color: Colors.Orange },
  ban: { label: 'Ban', emoji: '🔨', color: Colors.Red },
  unban: { label: 'Unban', emoji: '🕊️', color: Colors.Green },
  note: { label: 'Note', emoji: '📝', color: BRAND },
};

const ABLE = {
  warn: () => true,
  note: () => true,
  timeout: (m) => m.moderatable,
  kick: (m) => m.kickable,
  ban: (m) => m.bannable,
  nick: (m) => m.manageable,
};

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

// Entry for Discord's own audit log.
const auditReason = (moderator, reason) => `${moderator.user?.tag ?? moderator.tag}: ${reason}`.slice(0, 512);

async function postModLog(guild, embed) {
  const { modlog_channel_id } = getSettings(guild.id);
  const channel = modlog_channel_id && guild.channels.cache.get(modlog_channel_id);
  await channel?.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

// For logged events that aren't cases, such as locks and role changes.
function modLog(guild, { title, color, target, moderator, reason, extra }) {
  const lines = [
    target && `**User:** ${target} (\`${target.id}\`)`,
    `**Moderator:** ${moderator}`,
    reason && `**Reason:** ${reason}`,
    extra,
  ].filter(Boolean);
  return postModLog(guild, new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join('\n')).setTimestamp());
}

const getCase = (guildId, number) => db.prepare('SELECT * FROM cases WHERE guild_id = ? AND number = ?').get(guildId, number);

function caseEmbed(c) {
  const a = ACTIONS[c.action];
  const lines = [
    `**User:** <@${c.user_id}> (${escapeMarkdown(c.user_tag)} · \`${c.user_id}\`)`,
    `**Moderator:** <@${c.moderator_id}>`,
    `**Reason:** ${c.reason}`,
  ];
  if (c.duration_ms) lines.push(`**Duration:** ${formatDuration(c.duration_ms)}`);
  if (c.expires_at) lines.push(`**${c.active ? 'Expires' : 'Expired'}:** <t:${unix(c.expires_at)}:R>`);
  return new EmbedBuilder()
    .setColor(a.color)
    .setTitle(`${a.emoji} Case #${c.number} · ${a.label}`)
    .setDescription(lines.join('\n'))
    .setTimestamp(c.created_at);
}

// Stores a case and posts it to the mod log. Returns the case number.
async function recordCase(guild, { action, user, moderator, reason, durationMs = null, expiresAt = null, log = true }) {
  const number = (db.prepare('SELECT MAX(number) AS n FROM cases WHERE guild_id = ?').get(guild.id).n ?? 0) + 1;
  db.prepare(`
    INSERT INTO cases (guild_id, number, action, user_id, user_tag, moderator_id, reason, duration_ms, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guild.id, number, action, user.id, user.tag, moderator.id, reason || 'No reason given', durationMs, expiresAt, Date.now());
  // Notes are private to the /history view.
  if (log && action !== 'note') await postModLog(guild, caseEmbed(getCase(guild.id, number)));
  return number;
}

// Stops any pending temporary ban from lifting a newer ban, or runs after a manual unban.
const closeBans = (guildId, userId) =>
  db.prepare("UPDATE cases SET active = 0 WHERE guild_id = ? AND user_id = ? AND action = 'ban' AND active = 1").run(guildId, userId);

function activeWarnings(guildId, userId) {
  const { warn_expiry_ms } = getSettings(guildId);
  const since = warn_expiry_ms ? Date.now() - warn_expiry_ms : 0;
  return db.prepare("SELECT COUNT(*) AS n FROM cases WHERE guild_id = ? AND user_id = ? AND action = 'warn' AND active = 1 AND created_at >= ?")
    .get(guildId, userId, since).n;
}

// Best effort: members with DMs closed just don't get told.
const notify = (user, message) => user.send(message).catch(() => {});

// Applies the server's warning thresholds. Returns what happened, or null.
async function escalate(member, count) {
  const s = getSettings(member.guild.id);
  const bot = member.guild.members.me;
  const reason = `Automatic: reached ${count} warnings`;
  if (s.warn_kick_at && count >= s.warn_kick_at && member.kickable) {
    await notify(member.user, `👢 You were kicked from **${member.guild.name}** after ${count} warnings.`);
    journal.cannotUndo('Automatic kick after too many warnings');
    await member.kick(auditReason(bot, reason));
    await recordCase(member.guild, { action: 'kick', user: member.user, moderator: bot.user, reason });
    return `Kicked automatically (${count} warnings).`;
  }
  if (s.warn_timeout_at && count >= s.warn_timeout_at && member.moderatable) {
    const ms = s.warn_timeout_ms ?? 3_600_000;
    journal.timeout(member);
    await member.timeout(ms, auditReason(bot, reason));
    await recordCase(member.guild, { action: 'timeout', user: member.user, moderator: bot.user, reason, durationMs: ms });
    return `Timed out automatically for ${formatDuration(ms)} (${count} warnings).`;
  }
  return null;
}

async function expireBans(client) {
  const due = db.prepare("SELECT * FROM cases WHERE action = 'ban' AND active = 1 AND expires_at <= ?").all(Date.now());
  for (const c of due) {
    db.prepare('UPDATE cases SET active = 0 WHERE id = ?').run(c.id);
    const guild = client.guilds.cache.get(c.guild_id);
    const user = await guild?.bans.remove(c.user_id, `Temporary ban from case #${c.number} expired`).catch(() => null);
    if (user) await recordCase(guild, { action: 'unban', user, moderator: client.user, reason: `Temporary ban from case #${c.number} expired` });
  }
}

// Pulls user IDs out of free text, so pasted lists and mentions both work.
const parseIds = (text) => [...new Set(String(text).match(/\d{17,20}/g) ?? [])];

const reasonOption = (o) => o.setName('reason').setDescription('Why. Pick a saved reason or type your own').setMaxLength(400).setAutocomplete(true);

// Autocomplete only suggests; members can still submit whatever they typed.
const reasonChoices = (guildId, typed) =>
  db.prepare('SELECT text FROM reasons WHERE guild_id = ? AND text LIKE ? ORDER BY text LIMIT 25')
    .all(guildId, `%${typed}%`)
    .map(({ text }) => ({ name: text, value: text }));

// Makes a nickname readable: fancy fonts become plain letters, invisible characters and
// zalgo (3+ stacked accents on one letter) go, and leading symbols that push someone to
// the top of the member list are dropped. Normal accents like ç or ệ are kept.
function decancer(name) {
  const clean = name.normalize('NFKD')
    .replace(/[\p{Cf}\p{Cc}\p{Co}\p{Cn}]/gu, '')
    .replace(/[ᅟᅠㅤﾠ⠀]/g, '') // blank "letters" used for invisible names
    .replace(/\p{M}{3,}/gu, '')
    .normalize('NFC')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(clean) ? clean.slice(0, 32) : 'Moderated nickname';
}

module.exports = {
  MAX_TIMEOUT_MS, ACTIONS,
  checkTarget, auditReason, modLog, recordCase, getCase, caseEmbed, closeBans,
  activeWarnings, notify, escalate, expireBans, parseIds, reasonOption, reasonChoices, decancer,
};
