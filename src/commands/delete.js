const {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Colors, InteractionContextType, MessageFlags,
  PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { ephemeral } = require('../util');
const journal = require('../journal');
const mod = require('../moderation');

const P = PermissionFlagsBits;
const SETTING_NAMES = {
  modlog_channel_id: 'the mod log', message_log_id: 'the message log', member_log_id: 'the member log', voice_log_id: 'the voice log',
  appeals_channel_id: 'ban appeals', monitor_channel_id: 'the game server feed', autorole_id: 'the join role',
};
const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia];

// What the bot uses a channel or role for, so nobody deletes the mod log or the join role by accident.
function usesOf(guildId, id) {
  const settings = getSettings(guildId);
  const uses = Object.entries(SETTING_NAMES).filter(([column]) => settings[column] === id).map(([, name]) => name);
  for (const { name, config } of db.prepare('SELECT name, config FROM features WHERE guild_id = ?').all(guildId)) {
    if (config.includes(id)) uses.push(`${name} settings`);
  }
  return uses;
}

const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const cancel = () => button('cancel', 'Cancel', ButtonStyle.Secondary);

// Shows the question with its buttons and returns the button that was pressed, or null.
async function ask(i, text, buttons) {
  const response = await i.reply({ content: text, components: [new ActionRowBuilder().addComponents(...buttons, cancel())], flags: MessageFlags.Ephemeral });
  // Ends early if this channel is deleted meanwhile; then there is no message left to update.
  const choice = await response.awaitMessageComponent({ time: 60_000, filter: (b) => b.user.id === i.user.id }).catch(() => null);
  if (choice?.customId === 'cancel') await choice.update({ content: 'Cancelled. Nothing was deleted.', components: [] }).catch(() => {});
  else if (!choice) await i.editReply({ content: 'Timed out. Nothing was deleted.', components: [] }).catch(() => {});
  else await choice.update({ content: 'Deleting…', components: [] }).catch(() => {});
  return choice?.customId === 'cancel' ? null : choice;
}

// Replies with the result, by DM when the command ran inside a channel that is now gone.
async function finish(i, deletedIds, text) {
  if (deletedIds.includes(i.channelId)) await mod.notify(i.user, `${text}\n-# ${i.guild.name}`);
  else await i.editReply(text).catch(() => {});
}

async function deleteChannels(i, targets, reason, keptChildren = []) {
  const [first, ...rest] = targets;
  // Children first, then the category, so undo recreates the category before putting them back in it.
  for (const c of rest) journal.deletedChannel(c);
  journal.deletedChannel(first, keptChildren.map((c) => c.id));
  if (targets.some((c) => c.isTextBased?.() || c.type === ChannelType.GuildForum)) {
    journal.cannotUndo('Messages in the deleted channels (undo recreates the channels empty)');
  }
  let deleted = 0;
  for (const c of [...rest, first]) {
    if (await c.delete(mod.auditReason(i.member, reason)).then(() => true, () => false)) deleted++;
  }
  await mod.modLog(i.guild, {
    title: targets.length > 1 ? 'Channels deleted' : 'Channel deleted', color: Colors.Red, moderator: i.user, reason,
    extra: `**Deleted:** ${targets.map((c) => `#${c.name}`).join(', ').slice(0, 900)}${keptChildren.length ? `\n**Kept:** ${keptChildren.length} channels, now outside any category` : ''}`,
  });
  return deleted;
}

const warning = (uses) => (uses.length ? `\n**The bot uses this:** ${uses.join('; ')}.` : '');

async function execute(i) {
  const sub = i.options.getSubcommand();
  const reason = i.options.getString('reason') ?? 'No reason given';

  if (sub === 'role') {
    if (!i.memberPermissions.has(P.ManageRoles)) return i.reply(ephemeral('❌ Deleting roles needs the Manage Roles permission.'));
    const role = i.options.getRole('role', true);
    if (role.managed || role.id === i.guildId) return i.reply(ephemeral(`❌ ${role} belongs to Discord or an integration and can't be deleted.`));
    if (!role.editable) return i.reply(ephemeral(`❌ I can't delete ${role}. My role must be above it.`));
    if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) return i.reply(ephemeral(`❌ ${role} is equal to or above your highest role.`));

    // Load every member, so undo knows exactly who had the role.
    await i.guild.members.fetch().catch(() => null);
    const choice = await ask(i, [
      `**Delete the role ${escapeMarkdown(role.name)}?**`,
      `${role.members.size} members have it.${warning(usesOf(i.guildId, role.id))}`,
      '`/undo` recreates it with its permissions, gives it back to the same members and restores its channel permissions.',
    ].join('\n'), [button('delete', 'Delete role', ButtonStyle.Danger)]);
    if (!choice) return;
    journal.deletedRole(role);
    await role.delete(mod.auditReason(i.member, reason));
    await mod.modLog(i.guild, { title: 'Role deleted', color: Colors.Red, moderator: i.user, reason, extra: `**Role:** ${escapeMarkdown(role.name)} (${role.members.size} members)` });
    return finish(i, [], `✅ Deleted the role **${escapeMarkdown(role.name)}**. \`/undo\` brings it back.`);
  }

  const target = i.options.getChannel(sub, true);
  if (!target.deletable) return i.reply(ephemeral(`❌ I can't delete ${target}. I need Manage Channels there.`));
  if (!target.permissionsFor(i.member)?.has(P.ManageChannels)) return i.reply(ephemeral(`❌ You can't manage ${target}.`));

  if (sub === 'channel') {
    const choice = await ask(i, [
      `**Delete ${target}?**${warning(usesOf(i.guildId, target.id))}`,
      'Its messages are lost for good. `/undo` recreates the channel with its settings and permissions, but empty.',
    ].join('\n'), [button('delete', 'Delete channel', ButtonStyle.Danger)]);
    if (!choice) return;
    const deleted = await deleteChannels(i, [target], reason);
    return finish(i, [target.id], deleted ? `✅ Deleted **#${escapeMarkdown(target.name)}**. \`/undo\` recreates it.` : '❌ Discord refused to delete it.');
  }

  // Category: ask whether its channels go too.
  const children = [...target.children.cache.values()];
  const uses = [target, ...children].flatMap((c) => usesOf(i.guildId, c.id).map((u) => `${c} is ${u}`));
  const text = [
    `**Delete the category ${escapeMarkdown(target.name)}?**`,
    children.length ? `It has ${children.length} channel${children.length === 1 ? '' : 's'}: ${children.slice(0, 15).join(' ')}${children.length > 15 ? ' …' : ''}` : 'It is empty.',
    uses.length ? `**The bot uses these:** ${uses.join('; ')}.` : '',
    'Messages in deleted channels are lost for good. `/undo` recreates everything with its settings and permissions, but empty.',
  ].filter(Boolean).join('\n');
  const choice = await ask(i, text, children.length
    ? [button('only', 'Delete category only', ButtonStyle.Primary), button('all', `Delete category and ${children.length} channels`, ButtonStyle.Danger)]
    : [button('all', 'Delete category', ButtonStyle.Danger)]);
  if (!choice) return;

  const withChildren = choice.customId === 'all';
  const targets = [target, ...(withChildren ? children : [])];
  const deleted = await deleteChannels(i, targets, reason, withChildren ? [] : children);
  const kept = withChildren || !children.length ? '' : ` Its ${children.length} channels were kept.`;
  return finish(i, targets.map((c) => c.id), `✅ Deleted ${deleted} of ${targets.length}.${kept} \`/undo\` recreates them.`);
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('delete')
      .setDescription('Delete a channel, category or role. Undoable with /undo')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(P.ManageChannels)
      .addSubcommand((s) => s.setName('channel').setDescription('Delete a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(...CHANNEL_TYPES).setRequired(true))
        .addStringOption(mod.reasonOption))
      .addSubcommand((s) => s.setName('category').setDescription('Delete a category, with or without its channels')
        .addChannelOption((o) => o.setName('category').setDescription('Category').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addStringOption(mod.reasonOption))
      .addSubcommand((s) => s.setName('role').setDescription('Delete a role')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption(mod.reasonOption)),
    execute,
  },
];
