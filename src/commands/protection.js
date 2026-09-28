const {
  SlashCommandBuilder, EmbedBuilder, ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getFeature, setFeature } = require('../db');
const { formatDuration } = require('../monitor');
const { BRAND, ephemeral, parseDuration } = require('../util');
const antiraid = require('../antiraid');
const antinuke = require('../antinuke');
const antispam = require('../antispam');
const gate = require('../gate');

const P = PermissionFlagsBits;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const onOff = (on) => (on ? '🟢 On' : '⚪ Off');

const command = (name, description, permission) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(permission);

// Copies only the options the admin actually filled in over the saved settings.
function merge(saved, names) {
  const next = { ...saved };
  for (const [option, key, read] of names) {
    const value = read(option);
    if (value !== null) next[key] = value;
  }
  return next;
}

async function antiraidCommand(i) {
  const sub = i.options.getSubcommand();
  if (sub === 'end') {
    const summary = await antiraid.endRaid(i.guild, i.user);
    return i.reply(ephemeral(summary ? `✅ Raid mode ended: ${summary}.` : 'Raid mode is not active.'));
  }
  const int = (n) => i.options.getInteger(n);
  const bool = (n) => i.options.getBoolean(n);
  const cfg = merge(getFeature(i.guildId, 'antiraid', antiraid.DEFAULTS), [
    ['enabled', 'enabled', bool], ['joins', 'joins', int], ['seconds', 'seconds', int],
    ['raise_verification', 'verification', bool], ['lock_channels', 'lock', bool], ['kick_raiders', 'kick', bool],
  ]);
  setFeature(i.guildId, 'antiraid', cfg);
  const actions = [cfg.verification && 'raise verification', cfg.lock && 'lock channels', cfg.kick && 'kick raiders', 'alert staff'].filter(Boolean);
  return i.reply(ephemeral(cfg.enabled
    ? `✅ Anti-raid is on: **${cfg.joins} joins in ${cfg.seconds}s** will ${actions.join(', ')}.`
    : '✅ Anti-raid is off.'));
}

async function antinukeCommand(i) {
  // A compromised admin account would switch this off first, so only the owner can change it.
  if (i.user.id !== i.guild.ownerId) return i.reply(ephemeral('Only the server owner can change anti-nuke.'));
  const cfg = merge(getFeature(i.guildId, 'antinuke', antinuke.DEFAULTS), [
    ['enabled', 'enabled', (n) => i.options.getBoolean(n)], ['limit', 'limit', (n) => i.options.getInteger(n)], ['seconds', 'seconds', (n) => i.options.getInteger(n)],
  ]);
  setFeature(i.guildId, 'antinuke', cfg);
  const me = i.guild.members.me;
  const warning = cfg.enabled && !me.permissions.has(P.ViewAuditLog) ? '\n⚠️ I need the **View Audit Log** permission to see who did what.' : '';
  const roleNote = cfg.enabled ? `\nI can only strip roles below mine (${me.roles.highest}). Keep my role near the top.` : '';
  return i.reply(ephemeral((cfg.enabled
    ? `✅ Anti-nuke is on: anyone except you who bans, kicks, or deletes channels or roles **${cfg.limit} times in ${cfg.seconds}s** loses their roles.`
    : '✅ Anti-nuke is off.') + warning + roleNote));
}

async function antispamCommand(i) {
  if (!i.client.hasMessageContent) {
    return i.reply(ephemeral('Anti-spam needs the Message Content intent, which is off for this bot. The bot owner can turn it on in the Developer Portal.'));
  }
  const saved = getFeature(i.guildId, 'antispam', antispam.DEFAULTS);
  const cfg = merge(saved, [
    ['enabled', 'enabled', (n) => i.options.getBoolean(n)],
    ['flood', 'flood', (n) => i.options.getInteger(n)],
    ['duplicates', 'duplicates', (n) => i.options.getInteger(n)],
    ['caps', 'caps', (n) => i.options.getBoolean(n)],
    ['emojis', 'emojis', (n) => i.options.getInteger(n)],
    ['links', 'links', (n) => i.options.getString(n)],
  ]);
  const domains = i.options.getString('allowed_domains');
  if (domains !== null) {
    cfg.allowedDomains = domains.split(/[\s,]+/).map((d) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
  }
  setFeature(i.guildId, 'antispam', cfg);
  if (!cfg.enabled) return i.reply(ephemeral('✅ Anti-spam is off.'));
  const rules = [
    cfg.flood && `${cfg.flood} messages in 5s`,
    cfg.duplicates && `the same message ${cfg.duplicates} times`,
    cfg.caps && 'mostly capital letters',
    cfg.emojis && `more than ${cfg.emojis} emojis`,
    cfg.links === 'block' && 'any link',
    cfg.links === 'allowlist' && `links outside ${cfg.allowedDomains.join(', ') || '(no domains allowed yet)'}`,
  ].filter(Boolean);
  return i.reply(ephemeral(`✅ Anti-spam is on. It deletes and warns for: ${rules.join('; ') || 'nothing yet'}. Members with Manage Messages are skipped.`));
}

async function agegateCommand(i) {
  if (i.options.getSubcommand() === 'off') {
    setFeature(i.guildId, 'agegate', { ...getFeature(i.guildId, 'agegate', gate.AGE_DEFAULTS), enabled: false });
    return i.reply(ephemeral('✅ Age gate is off. People already in quarantine keep the role until approved.'));
  }
  const minAge = parseDuration(i.options.getString('min_age', true));
  if (!minAge) return i.reply(ephemeral('Use an age like `3d`, `7d` or `4w`.'));
  if (!i.guild.members.me.permissions.has([P.ManageRoles, P.ManageChannels])) {
    return i.reply(ephemeral('I need Manage Roles and Manage Channels to set up the quarantine role and channel.'));
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  setFeature(i.guildId, 'agegate', { ...getFeature(i.guildId, 'agegate', gate.AGE_DEFAULTS), enabled: true, minAgeMs: minAge });
  const { role, channel } = await gate.setupQuarantine(i.guild);
  return i.editReply(`✅ Accounts younger than **${formatDuration(minAge)}** get ${role} and can only see ${channel}. Staff approve them from the mod log or with \`/approve\`.`);
}

async function verificationCommand(i) {
  if (i.options.getSubcommand() === 'off') {
    setFeature(i.guildId, 'verification', {});
    return i.reply(ephemeral('✅ Verification is off. Delete the old panel message if it is still there.'));
  }
  const channel = i.options.getChannel('channel', true);
  const role = i.options.getRole('role', true);
  if (role.managed || role.id === i.guildId || !role.editable) return i.reply(ephemeral(`I can't give ${role}. Pick a normal role below mine.`));
  if (!channel.permissionsFor(i.guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
    return i.reply(ephemeral(`I can't post in ${channel}.`));
  }
  await gate.postVerifyPanel(channel, role, i.options.getString('message'));
  return i.reply(ephemeral(`✅ Posted the verification panel in ${channel}. Clicking it gives ${role}.\nMake sure @everyone can only see ${channel}, and ${role} can see the rest of the server.`));
}

async function protectionStatus(i) {
  const raid = getFeature(i.guildId, 'antiraid', antiraid.DEFAULTS);
  const raidState = getFeature(i.guildId, 'raid_state', antiraid.IDLE);
  const nuke = getFeature(i.guildId, 'antinuke', antinuke.DEFAULTS);
  const spam = getFeature(i.guildId, 'antispam', antispam.DEFAULTS);
  const age = getFeature(i.guildId, 'agegate', gate.AGE_DEFAULTS);
  const verify = getFeature(i.guildId, 'verification', {});
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('🛡️ Protection')
      .addFields(
        { name: 'Anti-raid', value: `${onOff(raid.enabled)}${raid.enabled ? ` · ${raid.joins} joins / ${raid.seconds}s` : ''}${raidState.active ? '\n🚨 **Raid mode active**' : ''}`, inline: true },
        { name: 'Anti-nuke', value: `${onOff(nuke.enabled)}${nuke.enabled ? ` · ${nuke.limit} actions / ${nuke.seconds}s` : ''}`, inline: true },
        { name: 'Anti-spam', value: i.client.hasMessageContent ? onOff(spam.enabled) : '⚪ Unavailable (no Message Content intent)', inline: true },
        { name: 'Age gate', value: `${onOff(age.enabled)}${age.enabled ? ` · under ${formatDuration(age.minAgeMs)}` : ''}`, inline: true },
        { name: 'Verification', value: verify.roleId ? `🟢 <#${verify.channelId}> → <@&${verify.roleId}>` : '⚪ Off', inline: true },
      )],
  });
}

module.exports = [
  {
    data: command('protection', 'Overview of raid, nuke and spam protection', P.ManageGuild),
    execute: protectionStatus,
  },

  {
    data: command('antiraid', 'React when many accounts join at once', P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Change anti-raid settings (empty options keep their value)')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
        .addIntegerOption((o) => o.setName('joins').setDescription('Joins that count as a raid (default 20)').setMinValue(3).setMaxValue(200))
        .addIntegerOption((o) => o.setName('seconds').setDescription('Within how many seconds (default 60)').setMinValue(5).setMaxValue(600))
        .addBooleanOption((o) => o.setName('raise_verification').setDescription('Require a verified phone during the raid (default on)'))
        .addBooleanOption((o) => o.setName('lock_channels').setDescription('Stop @everyone from posting during the raid'))
        .addBooleanOption((o) => o.setName('kick_raiders').setDescription('Kick accounts that joined during the raid')))
      .addSubcommand((s) => s.setName('end').setDescription('End raid mode and undo its changes')),
    execute: antiraidCommand,
  },

  {
    data: command('antinuke', 'Stop an account that suddenly bans or deletes a lot (server owner only)', P.Administrator)
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
      .addIntegerOption((o) => o.setName('limit').setDescription('Destructive actions allowed (default 3)').setMinValue(2).setMaxValue(20))
      .addIntegerOption((o) => o.setName('seconds').setDescription('Within how many seconds (default 10)').setMinValue(5).setMaxValue(300)),
    execute: antinukeCommand,
  },

  {
    data: command('antispam', 'Delete and warn for spam (empty options keep their value)', P.ManageGuild)
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
      .addIntegerOption((o) => o.setName('flood').setDescription('Messages in 5 seconds that count as flooding (0 = off, default 6)').setMinValue(0).setMaxValue(30))
      .addIntegerOption((o) => o.setName('duplicates').setDescription('Same message this many times in 30s (0 = off, default 3)').setMinValue(0).setMaxValue(20))
      .addBooleanOption((o) => o.setName('caps').setDescription('Block mostly-capital messages (default on)'))
      .addIntegerOption((o) => o.setName('emojis').setDescription('Most emojis in one message (0 = off, default 10)').setMinValue(0).setMaxValue(100))
      .addStringOption((o) => o.setName('links').setDescription('Link filter (default off)')
        .addChoices({ name: 'Off', value: 'off' }, { name: 'Block all links', value: 'block' }, { name: 'Only allowed domains', value: 'allowlist' }))
      .addStringOption((o) => o.setName('allowed_domains').setDescription('For the allowlist, e.g. youtube.com, twitch.tv').setMaxLength(1000)),
    execute: antispamCommand,
  },

  {
    data: command('agegate', 'Quarantine accounts that are too new', P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Turn on and set the minimum account age')
        .addStringOption((o) => o.setName('min_age').setDescription('e.g. 3d, 7d, 4w').setRequired(true)))
      .addSubcommand((s) => s.setName('off').setDescription('Turn the age gate off')),
    execute: agegateCommand,
  },

  {
    data: command('approve', 'Let a quarantined member into the server', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    async execute(i) {
      const member = i.options.getMember('user');
      if (!member) return i.reply(ephemeral('That user is not in this server.'));
      return i.reply(ephemeral(await gate.approve(member, i.member) ? `✅ Approved ${member}.` : `${member} isn't in quarantine.`));
    },
  },

  {
    data: command('verification', 'A button members click to get a role', P.ManageGuild)
      .addSubcommand((s) => s.setName('setup').setDescription('Post the verification panel')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('Text above the button').setMaxLength(2000)))
      .addSubcommand((s) => s.setName('off').setDescription('Stop giving the role')),
    execute: verificationCommand,
  },
];
