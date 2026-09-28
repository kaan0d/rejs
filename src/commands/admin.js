const {
  SlashCommandBuilder, EmbedBuilder, ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getSettings, setSetting, getFeature, setFeature } = require('../db');
const monitor = require('../monitor');
const setup = require('../setup');
const { BRAND, ephemeral, parseDuration } = require('../util');

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
    const countChannel = i.options.getChannel('count_channel');
    if (countChannel) setFeature(i.guildId, 'fivem', { countChannelId: countChannel.id });
    const countNote = countChannel ? ` ${countChannel} will show the player count (updated every 5 minutes at most, a Discord limit).` : '';
    return i.editReply(`✅ Watching \`${url}\` (${info.clients}/${info.sv_maxclients} players). Joins and leaves go to ${channel}.${countNote}`);
  }

  if (sub === 'monitor-off') {
    monitor.resetGuild(i.guildId);
    setSetting(i.guildId, 'server_url', null);
    setFeature(i.guildId, 'fivem', {});
    return i.reply(ephemeral('✅ Server monitoring is off. Playtime history is kept.'));
  }

  if (sub === 'modlog') {
    const channel = i.options.getChannel('channel');
    if (channel && !canPost(channel)) return i.reply(ephemeral(`I can't post in ${channel}. I need View Channel, Send Messages and Embed Links there.`));
    setSetting(i.guildId, 'modlog_channel_id', channel?.id ?? null);
    return i.reply(ephemeral(channel
      ? `✅ Moderation actions will be logged in ${channel}. Run \`/automod\` again to send AutoMod alerts there too.`
      : '✅ Moderation log is off.'));
  }

  if (sub === 'appeals') {
    const channel = i.options.getChannel('channel');
    if (channel && !canPost(channel)) return i.reply(ephemeral(`I can't post in ${channel}. I need View Channel, Send Messages and Embed Links there.`));
    setSetting(i.guildId, 'appeals_channel_id', channel?.id ?? null);
    return i.reply(ephemeral(channel
      ? `✅ Ban DMs now include an Appeal button. Appeals go to ${channel}, where anyone with Ban Members can accept or deny them.`
      : '✅ Ban appeals are off.'));
  }

  if (sub === 'reports' || sub === 'suggestions') {
    const channel = i.options.getChannel('channel');
    if (channel && !canPost(channel)) return i.reply(ephemeral(`I can't post in ${channel}. I need View Channel, Send Messages and Embed Links there.`));
    if (sub === 'suggestions' && channel && !channel.permissionsFor(i.guild.members.me).has(PermissionFlagsBits.CreatePublicThreads)) {
      return i.reply(ephemeral(`I also need Create Public Threads in ${channel} for the discussion threads.`));
    }
    setFeature(i.guildId, sub, { channelId: channel?.id ?? null });
    const on = sub === 'reports'
      ? `✅ Reports go to ${channel}. Members can use \`/report\` or right-click a message → Apps → Report message.`
      : `✅ Suggestions from \`/suggest\` are posted in ${channel}.`;
    return i.reply(ephemeral(channel ? on : `✅ ${sub[0].toUpperCase()}${sub.slice(1)} are off.`));
  }

  if (sub === 'autorole') {
    const role = i.options.getRole('role');
    if (role && (role.managed || role.id === i.guildId)) return i.reply(ephemeral("That role can't be handed out."));
    if (role && role.position >= i.guild.members.me.roles.highest.position) {
      return i.reply(ephemeral(`I can't give ${role}. Move my role above it in Server Settings → Roles.`));
    }
    setSetting(i.guildId, 'autorole_id', role?.id ?? null);
    return i.reply(ephemeral(role ? `✅ New members will get ${role}.` : '✅ Auto-role is off.'));
  }

  if (sub === 'warn-escalation') {
    const timeoutAt = i.options.getInteger('timeout_at', true);
    const kickAt = i.options.getInteger('kick_at', true);
    const duration = parseDuration(i.options.getString('timeout_duration') ?? '1h');
    if (!duration || duration > 28 * 86_400_000) return i.reply(ephemeral('Use a timeout duration like `30m`, `1h` or `1d`, up to 28 days.'));
    const expiryText = i.options.getString('expire_after');
    const expiry = expiryText && expiryText.trim() !== '0' ? parseDuration(expiryText) : null;
    if (expiryText && expiryText.trim() !== '0' && !expiry) return i.reply(ephemeral('Use an expiry like `30d` or `12w`, or `0` for never.'));
    setSetting(i.guildId, 'warn_timeout_at', timeoutAt || null);
    setSetting(i.guildId, 'warn_timeout_ms', duration);
    setSetting(i.guildId, 'warn_kick_at', kickAt || null);
    if (expiryText) setSetting(i.guildId, 'warn_expiry_ms', expiry);
    const rules = [
      timeoutAt && `timed out for ${monitor.formatDuration(duration)} at ${timeoutAt} warnings`,
      kickAt && `kicked at ${kickAt} warnings`,
    ].filter(Boolean);
    const expires = getSettings(i.guildId).warn_expiry_ms;
    const expiryNote = expires ? ` Warnings stop counting after ${monitor.formatDuration(expires)}.` : ' Warnings never expire.';
    return i.reply(ephemeral((rules.length ? `✅ Members will be automatically ${rules.join(', and ')}.` : '✅ Warning escalation is off.') + expiryNote));
  }

  const settings = getSettings(i.guildId);
  const escalation = [
    settings.warn_timeout_at && `Timeout (${monitor.formatDuration(settings.warn_timeout_ms)}) at ${settings.warn_timeout_at} warnings`,
    settings.warn_kick_at && `Kick at ${settings.warn_kick_at} warnings`,
    settings.warn_expiry_ms && `Warnings expire after ${monitor.formatDuration(settings.warn_expiry_ms)}`,
  ].filter(Boolean);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('⚙️ Settings')
      .addFields(
        { name: 'Game server', value: settings.server_url ? `\`${settings.server_url}\` → <#${settings.monitor_channel_id}>` : 'Off' },
        { name: 'Mod log', value: settings.modlog_channel_id ? `<#${settings.modlog_channel_id}>` : 'Off', inline: true },
        { name: 'Appeals', value: settings.appeals_channel_id ? `<#${settings.appeals_channel_id}>` : 'Off', inline: true },
        ...['reports', 'suggestions'].map((name) => {
          const { channelId } = getFeature(i.guildId, name, {});
          return { name: `${name[0].toUpperCase()}${name.slice(1)}`, value: channelId ? `<#${channelId}>` : 'Off', inline: true };
        }),
        { name: 'Auto-role', value: settings.autorole_id ? `<@&${settings.autorole_id}>` : 'Off', inline: true },
        { name: 'Warning escalation', value: escalation.join('\n') || 'Off' },
      )
      .setFooter({ text: 'Event logs: /logs show' })],
  });
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Quick setup: log channels, verification and quarantine')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    execute: (i) => i.reply({ ...setup.wizardMessage(i.guild), flags: MessageFlags.Ephemeral }),
  },

  {
    data: new SlashCommandBuilder()
      .setName('config')
      .setDescription('Bot settings for this server')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('monitor').setDescription('Watch a FiveM server and post joins and leaves')
        .addStringOption((o) => o.setName('address').setDescription('IP:port or URL, e.g. 1.2.3.4:30120').setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post updates').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addChannelOption((o) => o.setName('count_channel').setDescription('Voice channel renamed to show the player count').addChannelTypes(ChannelType.GuildVoice)))
      .addSubcommand((s) => s.setName('monitor-off').setDescription('Stop watching the game server'))
      .addSubcommand((s) => s.setName('modlog').setDescription('Where to log moderation actions and AutoMod alerts')
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to turn the log off').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('reports').setDescription('Where member reports go')
        .addChannelOption((o) => o.setName('channel').setDescription('Staff-only channel. Leave empty to turn reports off').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('suggestions').setDescription('Where /suggest posts go')
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to turn suggestions off').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('appeals').setDescription('Let banned members appeal from their ban DM')
        .addChannelOption((o) => o.setName('channel').setDescription('Where appeals go. Leave empty to turn appeals off').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('autorole').setDescription('Give new members a role when they join')
        .addRoleOption((o) => o.setName('role').setDescription('Leave empty to turn auto-role off')))
      .addSubcommand((s) => s.setName('warn-escalation').setDescription('Automatically punish members who collect warnings')
        .addIntegerOption((o) => o.setName('timeout_at').setDescription('Warnings before a timeout (0 = never)').setMinValue(0).setMaxValue(50).setRequired(true))
        .addIntegerOption((o) => o.setName('kick_at').setDescription('Warnings before a kick (0 = never)').setMinValue(0).setMaxValue(50).setRequired(true))
        .addStringOption((o) => o.setName('timeout_duration').setDescription('How long the timeout lasts (default 1h)'))
        .addStringOption((o) => o.setName('expire_after').setDescription('Warnings stop counting after, e.g. 30d. 0 = never')))
      .addSubcommand((s) => s.setName('show').setDescription('Show current settings')),
    execute: configure,
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
