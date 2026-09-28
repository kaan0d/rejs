const {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputStyle,
  PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { db, getFeature } = require('./db');
const { ephemeral } = require('./util');
const mod = require('./moderation');
const ui = require('./ui');
const journal = require('./journal');

const P = PermissionFlagsBits;
const COOLDOWN_MS = 60_000;
const HOUR_MS = 3_600_000;
const lastReport = new Map();
// Message text captured from the right-click menu, waiting for the reason form. Discord sends
// the text with the menu interaction even without the Message Content intent.
const pending = new Map();

const getReport = (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(id));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CATEGORIES = [
  { label: 'Spam or advertising', value: 'Spam', emoji: { name: '📢' } },
  { label: 'Harassment or hate', value: 'Harassment', emoji: { name: '😠' } },
  { label: 'NSFW or gore', value: 'NSFW', emoji: { name: '🔞' } },
  { label: 'Scam or phishing link', value: 'Scam', emoji: { name: '🎣' } },
  { label: 'Something else', value: 'Other', emoji: { name: '❓' } },
];

// The report form: what the message said, a category to pick and optional details.
const reasonModal = (customId, message) => new ModalBuilder()
  .setCustomId(customId)
  .setTitle('Report message')
  .addTextDisplayComponents((t) => t.setContent(`Reporting a message by **${message.author.username}**:\n> ${(message.content || '*no text*').slice(0, 300).replaceAll('\n', ' ')}`))
  .addLabelComponents((l) => l.setLabel("What's wrong?").setStringSelectMenuComponent((s) => s.setCustomId('category').setPlaceholder('Pick one').addOptions(CATEGORIES)))
  .addLabelComponents((l) => l.setLabel('Details').setDescription('Optional, but it helps staff act faster')
    .setTextInputComponent((t) => t.setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)));

function actionRow(report, { deleted = false } = {}) {
  const row = new ActionRowBuilder();
  if (report.message_id) {
    row.addComponents(new ButtonBuilder().setCustomId(`report-delete:${report.id}`).setLabel(deleted ? 'Deleted' : 'Delete message')
      .setEmoji('🗑️').setStyle(ButtonStyle.Secondary).setDisabled(deleted));
  }
  return row.addComponents(
    new ButtonBuilder().setCustomId(`report-warn:${report.id}`).setLabel('Warn').setEmoji('⚠️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report-timeout:${report.id}`).setLabel('Timeout 1h').setEmoji('🔇').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`report-ban:${report.id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`report-dismiss:${report.id}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
  );
}

// Returns an error for the reporter, or null once the report reached staff.
async function createReport(guild, reporter, target, reason, message = null) {
  const channel = guild.channels.cache.get(getFeature(guild.id, 'reports', {}).channelId);
  if (!channel) return 'Reports are not set up in this server. Ask the staff to run `/config reports`.';
  if (target.id === reporter.id) return "You can't report yourself.";
  if (target.bot) return "Bots can't be reported.";
  const key = `${guild.id}:${reporter.id}`;
  const readyAt = (lastReport.get(key) ?? 0) + COOLDOWN_MS;
  if (readyAt > Date.now()) return `You can report again <t:${Math.ceil(readyAt / 1000)}:R>.`;
  lastReport.set(key, Date.now());

  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO reports (guild_id, reporter_id, target_id, channel_id, message_id, content, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guild.id, reporter.id, target.id, message?.channelId ?? null, message?.id ?? null, message?.content ?? null, reason, Date.now());
  const report = getReport(id);

  const embed = new EmbedBuilder()
    .setColor(Colors.Orange)
    .setTitle(`🚩 Report #${id}`)
    .addFields(
      { name: 'Reported', value: `${target} (${escapeMarkdown(target.tag)} · \`${target.id}\`)`, inline: true },
      { name: 'By', value: `${reporter}`, inline: true },
      { name: 'Reason', value: reason },
    )
    .setThumbnail(target.displayAvatarURL())
    .setTimestamp();
  if (message) {
    embed.addFields({ name: 'Message', value: `${message.content ? clip(message.content, 900) : '*No text*'}\n[Jump to message](${message.url})` });
  }
  await channel.send({ embeds: [embed], components: [actionRow(report)], allowedMentions: { parse: [] } });
  return null;
}

// Marks the report handled, updates the staff message and tells the reporter.
async function finish(i, report, status, label, color) {
  db.prepare('UPDATE reports SET status = ?, handled_by = ? WHERE id = ?').run(status, i.user.id, report.id);
  await i.editReply(ui.finishCard(i.message, { status: `${label} by ${i.user.tag}`, color }));
  const reporter = await i.client.users.fetch(report.reporter_id).catch(() => null);
  await mod.notify(reporter, status === 'dismissed'
    ? `Thanks for your report #${report.id} in **${i.guild.name}**. Staff reviewed it and took no action.`
    : `Thanks for your report #${report.id} in **${i.guild.name}**. Staff reviewed it and took action.`);
}

// Buttons on a report: checks the permission and that the report is still open.
function reportButton(permission, run) {
  return async (i, id) => {
    if (!i.memberPermissions?.has(permission)) return i.reply(ephemeral("You don't have permission to do that."));
    const report = getReport(id);
    if (!report || report.status !== 'open') return i.update({ components: [] });
    // Punishing and DMing can take longer than Discord's 3-second reply window.
    await i.deferUpdate();
    const member = await i.guild.members.fetch(report.target_id).catch(() => null);
    return run(i, report, member);
  };
}

// Marks the report as being handled, so two staff clicking at once can't both act on it.
const claim = (id) => db.prepare("UPDATE reports SET status = 'handling' WHERE id = ? AND status = 'open'").run(id).changes > 0;
const release = (id) => db.prepare("UPDATE reports SET status = 'open' WHERE id = ? AND status = 'handling'").run(id);

async function punish(i, report, member, action, apply) {
  if (action !== 'ban' || member) {
    const error = mod.checkTarget(i.member, member, action);
    if (error) return i.followUp(ephemeral(error));
  }
  if (!claim(report.id)) return i.followUp(ephemeral('Someone else is already handling this report.'));
  try {
    const user = member?.user ?? await i.client.users.fetch(report.target_id);
    const reason = `Report #${report.id}: ${report.reason}`.slice(0, 400);
    const number = await apply(user, reason);
    await finish(i, report, 'handled', `${mod.ACTIONS[action].label} (case #${number})`, Colors.Green);
  } catch (error) {
    // Let someone try again after a failed ban or timeout.
    release(report.id);
    throw error;
  }
}

const handlers = {
  async 'report-form'(i, key) {
    const saved = pending.get(`${i.user.id}:${key}`);
    pending.delete(`${i.user.id}:${key}`);
    if (!saved) return i.reply(ephemeral('That form expired. Please report the message again.'));
    const details = i.fields.getTextInputValue('reason').trim();
    const reason = `${i.fields.getStringSelectValues('category')[0]}${details ? `: ${details}` : ''}`;
    const error = await createReport(i.guild, i.user, saved.author, reason, saved.message);
    return i.reply(ephemeral(error ?? '✅ Thanks. Your report was sent to the staff.'));
  },

  'report-delete': reportButton(P.ManageMessages, async (i, report) => {
    const channel = i.guild.channels.cache.get(report.channel_id);
    journal.cannotUndo('Deleted the reported message');
    const ok = await channel?.messages.delete(report.message_id).then(() => true, () => false);
    if (!ok) return i.followUp(ephemeral('That message is already gone.'));
    await i.editReply({ components: [actionRow(report, { deleted: true })] });
  }),

  'report-warn': reportButton(P.ModerateMembers, (i, report, member) => punish(i, report, member, 'warn', async (user, reason) => {
    const number = await mod.recordCase(i.guild, { action: 'warn', user, moderator: i.user, reason });
    await mod.notify(user, `⚠️ You were warned in **${i.guild.name}**: ${reason}`);
    await mod.escalate(member, mod.activeWarnings(i.guildId, user.id));
    return number;
  })),

  'report-timeout': reportButton(P.ModerateMembers, (i, report, member) => punish(i, report, member, 'timeout', async (user, reason) => {
    journal.timeout(member);
    await member.timeout(HOUR_MS, mod.auditReason(i.member, reason));
    await mod.notify(user, `🔇 You were timed out in **${i.guild.name}** for 1 hour: ${reason}`);
    return mod.recordCase(i.guild, { action: 'timeout', user, moderator: i.user, reason, durationMs: HOUR_MS });
  })),

  'report-ban': reportButton(P.BanMembers, (i, report, member) => punish(i, report, member, 'ban', async (user, reason) => {
    if (member) await mod.notify(user, `🔨 You were banned from **${i.guild.name}**: ${reason}`);
    mod.closeBans(i.guildId, user.id);
    await i.guild.bans.create(user.id, { reason: mod.auditReason(i.member, reason) });
    journal.banned(user.id);
    return mod.recordCase(i.guild, { action: 'ban', user, moderator: i.user, reason });
  })),

  'report-dismiss': reportButton(P.ModerateMembers, (i, report) => (claim(report.id)
    ? finish(i, report, 'dismissed', 'Dismissed', Colors.Grey)
    : i.followUp(ephemeral('Someone else is already handling this report.')))),
};

// Right-click → Apps → Report message: remember the message, then ask why.
async function reportMessage(i) {
  const message = i.targetMessage;
  if (message.author.bot) return i.reply(ephemeral("Bots can't be reported."));
  if (message.author.id === i.user.id) return i.reply(ephemeral("You can't report yourself."));
  pending.set(`${i.user.id}:${message.id}`, { author: message.author, message });
  setTimeout(() => pending.delete(`${i.user.id}:${message.id}`), 15 * 60_000).unref();
  await i.showModal(reasonModal(`report-form:${message.id}`, message));
}

module.exports = { handlers, createReport, reportMessage, reasonModal };
