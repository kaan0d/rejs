const {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { db, getFeature } = require('./db');
const { ephemeral } = require('./util');
const mod = require('./moderation');

const P = PermissionFlagsBits;
const COOLDOWN_MS = 60_000;
const HOUR_MS = 3_600_000;
const lastReport = new Map();
// Message text captured from the right-click menu, waiting for the reason form. Discord sends
// the text with the menu interaction even without the Message Content intent.
const pending = new Map();

const getReport = (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(id));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const reasonModal = (customId, title) => new ModalBuilder()
  .setCustomId(customId)
  .setTitle(title)
  .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
    .setCustomId('reason').setLabel('What is wrong?').setStyle(TextInputStyle.Paragraph).setMinLength(3).setMaxLength(500)));

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
  const embed = EmbedBuilder.from(i.message.embeds[0]).setColor(color).setFooter({ text: `${label} by ${i.user.tag}` });
  await i.update({ embeds: [embed], components: [] });
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
    const member = await i.guild.members.fetch(report.target_id).catch(() => null);
    return run(i, report, member);
  };
}

async function punish(i, report, member, action, apply) {
  if (action !== 'ban' || member) {
    const error = mod.checkTarget(i.member, member, action);
    if (error) return i.reply(ephemeral(error));
  }
  const user = member?.user ?? await i.client.users.fetch(report.target_id);
  const reason = `Report #${report.id}: ${report.reason}`.slice(0, 400);
  const number = await apply(user, reason);
  await finish(i, report, 'handled', `${mod.ACTIONS[action].label} (case #${number})`, Colors.Green);
}

const handlers = {
  async 'report-form'(i, key) {
    const saved = pending.get(`${i.user.id}:${key}`);
    pending.delete(`${i.user.id}:${key}`);
    if (!saved) return i.reply(ephemeral('That form expired. Please report the message again.'));
    const error = await createReport(i.guild, i.user, saved.author, i.fields.getTextInputValue('reason'), saved.message);
    return i.reply(ephemeral(error ?? '✅ Thanks. Your report was sent to the staff.'));
  },

  'report-delete': reportButton(P.ManageMessages, async (i, report) => {
    const channel = i.guild.channels.cache.get(report.channel_id);
    const ok = await channel?.messages.delete(report.message_id).then(() => true, () => false);
    if (!ok) return i.reply(ephemeral('That message is already gone.'));
    await i.update({ components: [actionRow(report, { deleted: true })] });
  }),

  'report-warn': reportButton(P.ModerateMembers, (i, report, member) => punish(i, report, member, 'warn', async (user, reason) => {
    const number = await mod.recordCase(i.guild, { action: 'warn', user, moderator: i.user, reason });
    await mod.notify(user, `⚠️ You were warned in **${i.guild.name}**: ${reason}`);
    await mod.escalate(member, mod.activeWarnings(i.guildId, user.id));
    return number;
  })),

  'report-timeout': reportButton(P.ModerateMembers, (i, report, member) => punish(i, report, member, 'timeout', async (user, reason) => {
    await member.timeout(HOUR_MS, mod.auditReason(i.member, reason));
    await mod.notify(user, `🔇 You were timed out in **${i.guild.name}** for 1 hour: ${reason}`);
    return mod.recordCase(i.guild, { action: 'timeout', user, moderator: i.user, reason, durationMs: HOUR_MS });
  })),

  'report-ban': reportButton(P.BanMembers, (i, report, member) => punish(i, report, member, 'ban', async (user, reason) => {
    if (member) await mod.notify(user, `🔨 You were banned from **${i.guild.name}**: ${reason}`);
    mod.closeBans(i.guildId, user.id);
    await i.guild.bans.create(user.id, { reason: mod.auditReason(i.member, reason) });
    return mod.recordCase(i.guild, { action: 'ban', user, moderator: i.user, reason });
  })),

  'report-dismiss': reportButton(P.ModerateMembers, (i, report) => finish(i, report, 'dismissed', 'Dismissed', Colors.Grey)),
};

// Right-click → Apps → Report message: remember the message, then ask why.
async function reportMessage(i) {
  const message = i.targetMessage;
  if (message.author.bot) return i.reply(ephemeral("Bots can't be reported."));
  if (message.author.id === i.user.id) return i.reply(ephemeral("You can't report yourself."));
  pending.set(`${i.user.id}:${message.id}`, { author: message.author, message });
  setTimeout(() => pending.delete(`${i.user.id}:${message.id}`), 15 * 60_000).unref();
  await i.showModal(reasonModal(`report-form:${message.id}`, 'Report message'));
}

module.exports = { handlers, createReport, reportMessage, reasonModal };
