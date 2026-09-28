const { SlashCommandBuilder, EmbedBuilder, ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { db, getSettings, setSetting } = require('../db');
const { BRAND, ephemeral } = require('../util');
const { COLUMNS } = require('../logs');

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
const TYPES = [
  { name: 'Messages (edits and deletes)', value: 'messages' },
  { name: 'Members (joins, leaves, roles, nicknames, timeouts)', value: 'members' },
  { name: 'Voice (joins, leaves, moves)', value: 'voice' },
];

async function logs(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'set') {
    const type = i.options.getString('type', true);
    const channel = i.options.getChannel('channel');
    if (channel && !channel.permissionsFor(i.guild.members.me)?.has(POST_PERMISSIONS)) {
      return i.reply(ephemeral(`I can't post in ${channel}. I need View Channel, Send Messages, Embed Links and Attach Files there.`));
    }
    setSetting(i.guildId, COLUMNS[type], channel?.id ?? null);
    const note = type === 'messages' && channel && !i.client.hasMessageContent
      ? '\n⚠️ The Message Content intent is off, so deleted messages will show without their text and edits are not logged.'
      : '';
    return i.reply(ephemeral(channel ? `✅ ${type[0].toUpperCase()}${type.slice(1)} logs go to ${channel}.${note}` : `✅ ${type} logs are off.`));
  }

  if (sub === 'ignore' || sub === 'unignore') {
    const target = i.options.getChannel('channel') ?? i.options.getRole('role');
    if (!target) return i.reply(ephemeral('Pick a channel or a role.'));
    if (sub === 'ignore') {
      db.prepare('INSERT OR IGNORE INTO log_ignores (guild_id, target_id, kind) VALUES (?, ?, ?)')
        .run(i.guildId, target.id, i.options.getChannel('channel') ? 'channel' : 'role');
      return i.reply(ephemeral(`✅ Logs will skip ${target}.`));
    }
    const { changes } = db.prepare('DELETE FROM log_ignores WHERE guild_id = ? AND target_id = ?').run(i.guildId, target.id);
    return i.reply(ephemeral(changes ? `✅ Logs include ${target} again.` : `${target} wasn't ignored.`));
  }

  const settings = getSettings(i.guildId);
  const ignores = db.prepare('SELECT target_id, kind FROM log_ignores WHERE guild_id = ?').all(i.guildId);
  const mention = (r) => (r.kind === 'channel' ? `<#${r.target_id}>` : `<@&${r.target_id}>`);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('📜 Logs')
      .addFields(
        ...TYPES.map((t) => ({ name: t.name, value: settings[COLUMNS[t.value]] ? `<#${settings[COLUMNS[t.value]]}>` : 'Off' })),
        { name: 'Ignored', value: ignores.map(mention).join(' ') || 'Nothing' },
      )
      .setFooter({ text: i.client.hasMessageContent ? 'Message content: available' : 'Message content: unavailable (intent off)' })],
  });
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Log server events to channels')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Choose where a type of event is logged')
        .addStringOption((o) => o.setName('type').setDescription('What to log').addChoices(...TYPES).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to turn this log off').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('ignore').setDescription("Don't log a channel or members with a role")
        .addChannelOption((o) => o.setName('channel').setDescription('Channel to skip'))
        .addRoleOption((o) => o.setName('role').setDescription('Role to skip')))
      .addSubcommand((s) => s.setName('unignore').setDescription('Log a channel or role again')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel'))
        .addRoleOption((o) => o.setName('role').setDescription('Role')))
      .addSubcommand((s) => s.setName('show').setDescription('Show log settings')),
    execute: logs,
  },
];
