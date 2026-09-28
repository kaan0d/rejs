const {
  SlashCommandBuilder, EmbedBuilder, ChannelType, Colors, InteractionContextType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { formatDuration } = require('../monitor');
const { ephemeral, parseDuration } = require('../util');
const { appealRow } = require('../appeals');
const mod = require('../moderation');
const journal = require('../journal');

const P = PermissionFlagsBits;
const reasonOf = (i) => i.options.getString('reason') ?? 'No reason given';
const unix = (ms) => Math.floor(ms / 1000);
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const channelOption = (o) => o.setName('channel').setDescription('Default: this channel').addChannelTypes(...TEXT_CHANNELS);
const DELETE_CHOICES = [{ name: 'Last hour', value: 3600 }, { name: 'Last day', value: 86_400 }, { name: 'Last 7 days', value: 604_800 }];

const command = (name, description, permission) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(permission);

async function warnings(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'remove') {
    const number = i.options.getInteger('case', true);
    const { changes } = db.prepare("UPDATE cases SET active = 0 WHERE guild_id = ? AND number = ? AND action = 'warn' AND active = 1")
      .run(i.guildId, number);
    return i.reply(ephemeral(changes ? `✅ Warning #${number} no longer counts.` : `Case #${number} isn't an active warning.`));
  }

  const user = i.options.getUser('user', true);
  if (sub === 'clear') {
    const { changes } = db.prepare("UPDATE cases SET active = 0 WHERE guild_id = ? AND user_id = ? AND action = 'warn' AND active = 1")
      .run(i.guildId, user.id);
    await mod.modLog(i.guild, { title: 'Warnings cleared', color: Colors.Grey, target: user, moderator: i.user, extra: `**Cleared:** ${changes}` });
    return i.reply(ephemeral(`✅ Cleared ${changes} warning${changes === 1 ? '' : 's'} for ${user}.`));
  }

  const { warn_expiry_ms } = getSettings(i.guildId);
  const rows = db.prepare("SELECT * FROM cases WHERE guild_id = ? AND user_id = ? AND action = 'warn' AND active = 1 ORDER BY number DESC LIMIT 25")
    .all(i.guildId, user.id);
  const counting = mod.activeWarnings(i.guildId, user.id);
  const lines = rows.map((c) => {
    const expired = warn_expiry_ms && c.created_at < Date.now() - warn_expiry_ms ? ' · *expired*' : '';
    return `\`#${c.number}\` <t:${unix(c.created_at)}:R> by <@${c.moderator_id}>${expired}\n${c.reason}`;
  });
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(counting ? Colors.Orange : Colors.Green)
      .setAuthor({ name: `${user.username} · ${counting} active warning${counting === 1 ? '' : 's'}`, iconURL: user.displayAvatarURL() })
      .setDescription(lines.join('\n\n') || 'Clean record.')
      .setFooter(warn_expiry_ms ? { text: `Warnings stop counting after ${formatDuration(warn_expiry_ms)}` } : null)],
  });
}

async function ban(i) {
  const user = i.options.getUser('user', true);
  const member = i.options.getMember('user');
  if (member) {
    const error = mod.checkTarget(i.member, member, 'ban');
    if (error) return i.reply(ephemeral(error));
  }
  const durationText = i.options.getString('duration');
  const durationMs = durationText ? parseDuration(durationText) : null;
  if (durationText && !durationMs) return i.reply(ephemeral('Use a duration like `12h`, `7d` or `4w`, or leave it empty for a permanent ban.'));

  const reason = reasonOf(i);
  const expiresAt = durationMs ? Date.now() + durationMs : null;
  // DM first: once banned, they no longer share a server with the bot.
  if (member) {
    const until = expiresAt ? ` until <t:${unix(expiresAt)}:f>` : '';
    await mod.notify(user, { content: `You were banned from **${i.guild.name}**${until}: ${reason}`, components: appealRow(i.guildId) });
  }
  mod.closeBans(i.guildId, user.id);
  await i.guild.bans.create(user.id, {
    reason: mod.auditReason(i.member, reason),
    deleteMessageSeconds: i.options.getInteger('delete_messages') ?? 0,
  });
  journal.banned(user.id);
  if (i.options.getInteger('delete_messages')) journal.cannotUndo('Deleted messages');
  const number = await mod.recordCase(i.guild, { action: 'ban', user, moderator: i.user, reason, durationMs, expiresAt });
  await i.reply(`Banned **${user.tag}**${expiresAt ? ` until <t:${unix(expiresAt)}:f>` : ''}. (case #${number})`);
}

async function setLock(i, locked) {
  const channel = i.options.getChannel('channel') ?? i.channel;
  journal.overwrite(channel, i.guild.roles.everyone.id);
  await channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: locked ? false : null },
    { reason: mod.auditReason(i.member, locked ? 'Lock' : 'Unlock') });
  await mod.modLog(i.guild, { title: locked ? 'Channel locked' : 'Channel unlocked', color: Colors.Grey, moderator: i.user, extra: `**Channel:** ${channel}` });
  return i.reply(locked ? `${channel} is locked. Only staff can talk here.` : `${channel} is unlocked.`);
}

module.exports = [
  {
    data: command('warn', 'Warn a member', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => mod.reasonOption(o).setRequired(true)),
    async execute(i) {
      const member = i.options.getMember('user');
      const error = mod.checkTarget(i.member, member, 'warn');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      const number = await mod.recordCase(i.guild, { action: 'warn', user: member.user, moderator: i.user, reason });
      const count = mod.activeWarnings(i.guildId, member.id);
      await mod.notify(member.user, `⚠️ You were warned in **${i.guild.name}**: ${reason}`);
      const auto = await mod.escalate(member, count);
      await i.reply(`⚠️ Warned ${member} (${count} active, case #${number}).${auto ? ` ${auto}` : ''}`);
    },
  },

  {
    data: command('warnings', "See or remove a member's warnings", P.ModerateMembers)
      .addSubcommand((s) => s.setName('list').setDescription("Show a member's warnings")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Stop one warning from counting')
        .addIntegerOption((o) => o.setName('case').setDescription('Case number from /warnings list').setRequired(true)))
      .addSubcommand((s) => s.setName('clear').setDescription("Stop all of a member's warnings from counting")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
    execute: warnings,
  },

  {
    data: command('timeout', 'Stop a member from talking for a while', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d (max 28d)').setRequired(true))
      .addStringOption(mod.reasonOption),
    async execute(i) {
      const member = i.options.getMember('user');
      const ms = parseDuration(i.options.getString('duration', true));
      if (!ms || ms > mod.MAX_TIMEOUT_MS) return i.reply(ephemeral('Use a duration like `10m`, `1h` or `2d`, up to 28 days.'));
      const error = mod.checkTarget(i.member, member, 'timeout');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      journal.timeout(member);
      await member.timeout(ms, mod.auditReason(i.member, reason));
      await mod.notify(member.user, `You were timed out in **${i.guild.name}** for ${formatDuration(ms)}: ${reason}`);
      const number = await mod.recordCase(i.guild, { action: 'timeout', user: member.user, moderator: i.user, reason, durationMs: ms });
      await i.reply(`${member} is timed out until <t:${unix(Date.now() + ms)}:t>. (case #${number})`);
    },
  },

  {
    data: command('untimeout', 'Lift a timeout early', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(mod.reasonOption),
    async execute(i) {
      const member = i.options.getMember('user');
      if (!member?.isCommunicationDisabled()) return i.reply(ephemeral("That member isn't timed out."));
      const error = mod.checkTarget(i.member, member, 'timeout');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      journal.timeout(member);
      await member.timeout(null, mod.auditReason(i.member, reason));
      const number = await mod.recordCase(i.guild, { action: 'untimeout', user: member.user, moderator: i.user, reason });
      await i.reply(`${member} can talk again. (case #${number})`);
    },
  },

  {
    data: command('kick', 'Remove a member from the server', P.KickMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(mod.reasonOption),
    async execute(i) {
      const member = i.options.getMember('user');
      const error = mod.checkTarget(i.member, member, 'kick');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      await mod.notify(member.user, `You were kicked from **${i.guild.name}**: ${reason}`);
      journal.cannotUndo('Kick (they have to rejoin themselves)');
      await member.kick(mod.auditReason(i.member, reason));
      const number = await mod.recordCase(i.guild, { action: 'kick', user: member.user, moderator: i.user, reason });
      await i.reply(`Kicked **${member.user.tag}**. (case #${number})`);
    },
  },

  {
    data: command('ban', 'Ban a user, even one who already left', P.BanMembers)
      .addUserOption((o) => o.setName('user').setDescription('User or user ID').setRequired(true))
      .addStringOption(mod.reasonOption)
      .addStringOption((o) => o.setName('duration').setDescription('Lift the ban automatically after, e.g. 7d. Empty = permanent'))
      .addIntegerOption((o) => o.setName('delete_messages').setDescription('Also delete their recent messages').addChoices(...DELETE_CHOICES)),
    execute: ban,
  },

  {
    data: command('softban', 'Ban and unban at once to delete messages. They can rejoin', P.BanMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(mod.reasonOption)
      .addIntegerOption((o) => o.setName('delete_messages').setDescription('How much to delete (default: last day)').addChoices(...DELETE_CHOICES)),
    async execute(i) {
      const member = i.options.getMember('user');
      const error = mod.checkTarget(i.member, member, 'ban');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      await mod.notify(member.user, `You were removed from **${i.guild.name}** and your recent messages were deleted: ${reason}. You can rejoin.`);
      journal.cannotUndo('Softban (deleted messages; they have to rejoin themselves)');
      await i.guild.bans.create(member.id, {
        reason: mod.auditReason(i.member, `Softban: ${reason}`),
        deleteMessageSeconds: i.options.getInteger('delete_messages') ?? 86_400,
      });
      await i.guild.bans.remove(member.id, mod.auditReason(i.member, 'Softban'));
      const number = await mod.recordCase(i.guild, { action: 'softban', user: member.user, moderator: i.user, reason });
      await i.reply(`Softbanned **${member.user.tag}**. Their messages are gone and they can rejoin. (case #${number})`);
    },
  },

  {
    data: command('unban', 'Lift a ban', P.BanMembers)
      .addStringOption((o) => o.setName('user_id').setDescription('ID of the banned user').setRequired(true))
      .addStringOption(mod.reasonOption),
    async execute(i) {
      const id = mod.parseIds(i.options.getString('user_id', true))[0];
      if (!id) return i.reply(ephemeral("That isn't a user ID."));
      const reason = reasonOf(i);
      const user = await i.guild.bans.remove(id, mod.auditReason(i.member, reason)).catch(() => null);
      if (!user) return i.reply(ephemeral("That user isn't banned."));
      journal.unbanned(user.id);
      mod.closeBans(i.guildId, user.id);
      const number = await mod.recordCase(i.guild, { action: 'unban', user, moderator: i.user, reason });
      await i.reply(`Unbanned **${user.tag}**. (case #${number})`);
    },
  },

  {
    data: command('lock', 'Stop everyone except staff from talking in a channel', P.ManageChannels).addChannelOption(channelOption),
    execute: (i) => setLock(i, true),
  },

  {
    data: command('unlock', 'Let everyone talk in a channel again', P.ManageChannels).addChannelOption(channelOption),
    execute: (i) => setLock(i, false),
  },

  {
    data: command('slowmode', 'Limit how often members can post in a channel', P.ManageChannels)
      .addStringOption((o) => o.setName('delay').setDescription('e.g. 5s, 1m, 2h (max 6h). 0 turns it off').setRequired(true))
      .addChannelOption(channelOption),
    async execute(i) {
      const channel = i.options.getChannel('channel') ?? i.channel;
      const input = i.options.getString('delay', true);
      const ms = input.trim() === '0' ? 0 : parseDuration(input);
      if (ms === null || ms > 6 * 3_600_000) return i.reply(ephemeral('Use a delay like `5s`, `1m` or `2h`, up to 6 hours, or `0` to turn it off.'));
      journal.channelField(channel, 'rateLimitPerUser');
      await channel.setRateLimitPerUser(Math.round(ms / 1000), mod.auditReason(i.member, 'Slowmode'));
      await i.reply(ms ? `Slowmode in ${channel}: one message every ${Math.round(ms / 1000)}s.` : `Slowmode is off in ${channel}.`);
    },
  },
];
