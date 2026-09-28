const {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Colors, InteractionContextType, MessageFlags,
  PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { ephemeral } = require('../util');
const journal = require('../journal');
const mod = require('../moderation');

const SETTING_NAMES = {
  modlog_channel_id: 'the mod log', message_log_id: 'the message log', member_log_id: 'the member log', voice_log_id: 'the voice log',
  appeals_channel_id: 'ban appeals', monitor_channel_id: 'the game server feed',
};

// What the bot uses this channel for, so nobody deletes the mod log by accident.
function usesOf(guildId, id) {
  const settings = getSettings(guildId);
  const uses = Object.entries(SETTING_NAMES).filter(([column]) => settings[column] === id).map(([, name]) => name);
  for (const { name, config } of db.prepare('SELECT name, config FROM features WHERE guild_id = ?').all(guildId)) {
    if (config.includes(id)) uses.push(`${name} settings`);
  }
  return uses;
}

const describe = (c) => `${c.type === ChannelType.GuildCategory ? 'category' : 'channel'} **${escapeMarkdown(c.name)}**`;

async function deleteChannels(i, targets, reason) {
  let deleted = 0;
  for (const c of targets) {
    if (await c.delete(mod.auditReason(i.member, reason)).then(() => true, () => false)) deleted++;
  }
  return deleted;
}

async function execute(i) {
  const target = i.options.getChannel('channel', true);
  const reason = i.options.getString('reason') ?? 'No reason given';
  if (!target.deletable) return i.reply(ephemeral(`I can't delete ${describe(target)}. I need Manage Channels there.`));
  if (!target.permissionsFor(i.member)?.has(PermissionFlagsBits.ManageChannels)) return i.reply(ephemeral(`You can't manage ${describe(target)}.`));

  const isCategory = target.type === ChannelType.GuildCategory;
  const children = isCategory ? [...target.children.cache.values()] : [];
  const uses = [target, ...children].flatMap((c) => usesOf(i.guildId, c.id).map((u) => `${c} is ${u}`));
  const lines = [`🗑️ Delete ${describe(target)}?`];
  if (isCategory && children.length) lines.push(`It has **${children.length}** channel${children.length === 1 ? '' : 's'}: ${children.slice(0, 15).map((c) => `${c}`).join(' ')}${children.length > 15 ? ' …' : ''}`);
  if (uses.length) lines.push(`⚠️ The bot uses these: ${uses.join('; ')}.`);
  lines.push('Messages are lost for good. `/undo` recreates the channels with their settings and permissions, but empty.');

  const buttons = isCategory && children.length
    ? [
      new ButtonBuilder().setCustomId('only').setLabel('Delete only the category').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('all').setLabel(`Delete category + ${children.length} channels`).setStyle(ButtonStyle.Danger),
    ]
    : [new ButtonBuilder().setCustomId('all').setLabel('Delete').setStyle(ButtonStyle.Danger)];
  buttons.push(new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));

  const response = await i.reply({ content: lines.join('\n'), components: [new ActionRowBuilder().addComponents(buttons)], flags: MessageFlags.Ephemeral });
  const choice = await response.awaitMessageComponent({ time: 60_000 }).catch(() => null);
  if (!choice || choice.customId === 'cancel') {
    return (choice ? choice.update({ content: 'Cancelled. Nothing was deleted.', components: [] }) : i.editReply({ content: 'Timed out. Nothing was deleted.', components: [] }));
  }
  await choice.update({ content: '⏳ Deleting…', components: [] });

  const withChildren = choice.customId === 'all';
  const doomed = withChildren ? children : [];
  // Children first, then the category, so undo recreates the category before putting them back in it.
  for (const c of doomed) journal.deletedChannel(c);
  journal.deletedChannel(target, withChildren ? [] : children.map((c) => c.id));
  if ([target, ...doomed].some((c) => c.isTextBased?.() || c.type === ChannelType.GuildForum)) {
    journal.cannotUndo('Messages in the deleted channels (undo recreates them empty)');
  }

  const deleted = await deleteChannels(i, [...doomed, target], reason);
  const names = [target, ...doomed].map((c) => `#${c.name}`).join(', ');
  await mod.modLog(i.guild, {
    title: '🗑️ Channels deleted', color: Colors.Red, moderator: i.user, reason,
    extra: `**Deleted:** ${names.slice(0, 900)}${isCategory && !withChildren && children.length ? `\n**Kept:** ${children.length} channels, now outside any category` : ''}`,
  });
  // The reply may live in a channel that was just deleted.
  await i.editReply(`✅ Deleted ${deleted} of ${doomed.length + 1}. Changed your mind? \`/undo\` recreates them.`).catch(() => {});
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('channel')
      .setDescription('Manage channels')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a channel or a category (you choose whether its channels go too)')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel or category').setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement,
            ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia))
        .addStringOption(mod.reasonOption)),
    execute,
  },
];
