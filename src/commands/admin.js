const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Colors,
  InteractionContextType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { db, getSettings, setSetting } = require('../db');
const levels = require('../levels');
const monitor = require('../monitor');

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const POST_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

const canPost = (channel) => channel.permissionsFor(channel.guild.members.me)?.has(POST_PERMISSIONS);

async function configure(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'monitor') {
    const url = monitor.normalizeServerUrl(i.options.getString('address', true));
    const channel = i.options.getChannel('channel', true);
    if (!url) return i.reply(ephemeral("That doesn't look like an address. Try `1.2.3.4:30120`."));
    if (!canPost(channel)) return i.reply(ephemeral(`I can't post in ${channel}. I need View Channel, Send Messages and Embed Links there.`));

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let info;
    try {
      ({ info } = await monitor.fetchServer(url));
    } catch (e) {
      return i.editReply(`❌ Couldn't reach \`${url}\` (${e.message}). Check the address and that the server is running.`);
    }
    monitor.resetGuild(i.guildId);
    setSetting(i.guildId, 'server_url', url);
    setSetting(i.guildId, 'monitor_channel_id', channel.id);
    return i.editReply(`✅ Watching \`${url}\` (${info.clients}/${info.sv_maxclients} players). Joins and leaves go to ${channel}.`);
  }

  if (sub === 'monitor-off') {
    monitor.resetGuild(i.guildId);
    setSetting(i.guildId, 'server_url', null);
    return i.reply(ephemeral('✅ Server monitoring is off. Playtime history is kept.'));
  }

  if (sub === 'levelup-channel') {
    const channel = i.options.getChannel('channel');
    if (channel && !canPost(channel)) return i.reply(ephemeral(`I can't post in ${channel}. I need View Channel, Send Messages and Embed Links there.`));
    setSetting(i.guildId, 'levelup_channel_id', channel?.id ?? null);
    return i.reply(ephemeral(channel
      ? `✅ Level-ups will be announced in ${channel}.`
      : '✅ Level-ups will be announced where the thanks happened.'));
  }

  const settings = getSettings(i.guildId);
  const rewards = db.prepare('SELECT level, role_id FROM level_roles WHERE guild_id = ? ORDER BY level').all(i.guildId);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle('⚙️ Settings')
      .addFields(
        { name: 'Game server', value: settings.server_url ? `\`${settings.server_url}\` → <#${settings.monitor_channel_id}>` : 'Off' },
        { name: 'Level-up announcements', value: settings.levelup_channel_id ? `<#${settings.levelup_channel_id}>` : 'Where the thanks happened' },
        { name: 'Level rewards', value: rewards.map((r) => `Level ${r.level} → <@&${r.role_id}>`).join('\n') || 'None' },
      )],
  });
}

async function levelRole(i) {
  const level = i.options.getInteger('level', true);

  if (i.options.getSubcommand() === 'remove') {
    const { changes } = db.prepare('DELETE FROM level_roles WHERE guild_id = ? AND level = ?').run(i.guildId, level);
    return i.reply(ephemeral(changes ? `✅ Removed the level ${level} reward.` : `There is no reward at level ${level}.`));
  }

  const role = i.options.getRole('role', true);
  if (role.managed || role.id === i.guildId) return i.reply(ephemeral("That role can't be handed out."));
  if (role.position >= i.guild.members.me.roles.highest.position) {
    return i.reply(ephemeral(`I can't give ${role}. Move my role above it in Server Settings → Roles.`));
  }
  db.prepare(`
    INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, level) DO UPDATE SET role_id = excluded.role_id
  `).run(i.guildId, level, role.id);
  return i.reply(ephemeral(`✅ Members reaching level ${level} will get ${role}.`));
}

async function manageXp(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'reset-all') {
    if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      return i.reply(ephemeral('Only administrators can reset everyone.'));
    }
    const response = await i.reply({
      content: "⚠️ This wipes every member's level and XP in this server. Are you sure?",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm').setLabel('Reset everyone').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
      flags: MessageFlags.Ephemeral,
    });
    try {
      const button = await response.awaitMessageComponent({ time: 30_000 });
      if (button.customId !== 'confirm') return button.update({ content: 'Cancelled. Nothing changed.', components: [] });
      const { changes } = db.prepare('DELETE FROM levels WHERE guild_id = ?').run(i.guildId);
      return button.update({ content: `✅ Reset ${changes} members.`, components: [] });
    } catch {
      return i.editReply({ content: 'Timed out. Nothing changed.', components: [] });
    }
  }

  const user = i.options.getUser('user', true);
  if (user.bot) return i.reply(ephemeral("Bots don't collect XP."));

  if (sub === 'reset') {
    db.prepare('DELETE FROM levels WHERE guild_id = ? AND user_id = ?').run(i.guildId, user.id);
    return i.reply(ephemeral(`✅ Reset ${user}'s level and XP.`));
  }

  const change = sub === 'add'
    ? levels.grantXp(i.guildId, user.id, i.options.getInteger('amount', true))
    : levels.setLevel(i.guildId, user.id, i.options.getInteger('level', true));
  await i.reply(ephemeral(`✅ ${user} is now level ${change.after.level}.`));
  await levels.announceLevelUp(i.guild, user, change, i.channel);
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('config')
      .setDescription('Bot settings for this server')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('monitor').setDescription('Watch a FiveM server and post joins and leaves')
        .addStringOption((o) => o.setName('address').setDescription('IP:port or URL, e.g. 1.2.3.4:30120').setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post updates').addChannelTypes(...TEXT_CHANNELS).setRequired(true)))
      .addSubcommand((s) => s.setName('monitor-off').setDescription('Stop watching the game server'))
      .addSubcommand((s) => s.setName('levelup-channel').setDescription('Where to announce level-ups')
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to announce where the thanks happened').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('show').setDescription('Show current settings')),
    execute: configure,
  },

  {
    data: new SlashCommandBuilder()
      .setName('levelrole')
      .setDescription('Give a role when members reach a level')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((s) => s.setName('add').setDescription('Add or replace a level reward')
        .addIntegerOption((o) => o.setName('level').setDescription('Level that earns the role').setMinValue(2).setMaxValue(levels.MAX_LEVEL).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a level reward')
        .addIntegerOption((o) => o.setName('level').setDescription('Level of the reward').setMinValue(2).setMaxValue(levels.MAX_LEVEL).setRequired(true))),
    execute: levelRole,
  },

  {
    data: new SlashCommandBuilder()
      .setName('xp')
      .setDescription("Manage members' levels")
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Give XP to a member')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('XP to give').setMinValue(1).setMaxValue(100_000).setRequired(true)))
      .addSubcommand((s) => s.setName('set-level').setDescription("Set a member's level (XP goes back to 0)")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('level').setDescription('New level').setMinValue(levels.MIN_LEVEL).setMaxValue(levels.MAX_LEVEL).setRequired(true)))
      .addSubcommand((s) => s.setName('reset').setDescription("Wipe one member's level and XP")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('reset-all').setDescription("Wipe everyone's level and XP (administrators only)")),
    execute: manageXp,
  },

  {
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Delete recent messages in this channel')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this member')),
    async execute(i) {
      const amount = i.options.getInteger('amount', true);
      const user = i.options.getUser('user');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        let target = amount;
        if (user) {
          const recent = await i.channel.messages.fetch({ limit: 100 });
          target = recent.filter((m) => m.author.id === user.id).first(amount);
        }
        // Discord can't bulk delete messages older than 14 days; those are skipped.
        const deleted = await i.channel.bulkDelete(target, true);
        await i.editReply(`🧹 Deleted ${deleted.size} message${deleted.size === 1 ? '' : 's'}.`);
      } catch (e) {
        await i.editReply(`❌ Couldn't delete messages: ${e.message}`);
      }
    },
  },
];
