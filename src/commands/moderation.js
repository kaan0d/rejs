const {
  SlashCommandBuilder, EmbedBuilder, ChannelType, Colors, InteractionContextType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { db } = require('../db');
const { formatDuration } = require('../monitor');
const { ephemeral, parseDuration } = require('../util');
const mod = require('../moderation');

const P = PermissionFlagsBits;
const reasonOf = (i) => i.options.getString('reason') ?? 'No reason given';
const reasonOption = (o) => o.setName('reason').setDescription('Why (shown in the mod log)').setMaxLength(400);
const unix = (ms) => Math.floor(ms / 1000);

const command = (name, description, permission) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(permission);

async function warnings(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'remove') {
    const id = i.options.getInteger('id', true);
    const { changes } = db.prepare('DELETE FROM warnings WHERE guild_id = ? AND id = ?').run(i.guildId, id);
    return i.reply(ephemeral(changes ? `✅ Removed warning #${id}.` : `There is no warning #${id} here.`));
  }

  const user = i.options.getUser('user', true);
  if (sub === 'clear') {
    const { changes } = db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?').run(i.guildId, user.id);
    await mod.modLog(i.guild, { title: '🧽 Warnings cleared', color: Colors.Grey, target: user, moderator: i.user, extra: `**Removed:** ${changes}` });
    return i.reply(ephemeral(`✅ Cleared ${changes} warning${changes === 1 ? '' : 's'} for ${user}.`));
  }

  const rows = db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 25').all(i.guildId, user.id);
  const lines = rows.map((w) => `\`#${w.id}\` <t:${unix(w.created_at)}:R> by <@${w.moderator_id}>\n${w.reason}`);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(rows.length ? Colors.Orange : Colors.Green)
      .setAuthor({ name: `${user.username} · ${rows.length} warning${rows.length === 1 ? '' : 's'}`, iconURL: user.displayAvatarURL() })
      .setDescription(lines.join('\n\n') || 'Clean record.')],
  });
}

async function setLock(i, locked) {
  const channel = i.options.getChannel('channel') ?? i.channel;
  await channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: locked ? false : null }, { reason: mod.auditReason(i.member, locked ? 'Lock' : 'Unlock') });
  await mod.modLog(i.guild, { title: locked ? '🔒 Channel locked' : '🔓 Channel unlocked', color: Colors.Grey, moderator: i.user, extra: `**Channel:** ${channel}` });
  return i.reply(locked ? `🔒 ${channel} is locked. Only staff can talk here.` : `🔓 ${channel} is unlocked.`);
}

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const channelOption = (o) => o.setName('channel').setDescription('Default: this channel').addChannelTypes(...TEXT_CHANNELS);

module.exports = [
  {
    data: command('warn', 'Warn a member', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => reasonOption(o).setRequired(true)),
    async execute(i) {
      const member = i.options.getMember('user');
      const error = mod.checkTarget(i.member, member, 'warn');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      const count = mod.addWarning(i.guildId, member.id, i.user.id, reason);
      await mod.notify(member.user, `⚠️ You were warned in **${i.guild.name}**: ${reason}`);
      await mod.modLog(i.guild, { title: '⚠️ Warning', color: Colors.Yellow, target: member.user, moderator: i.user, reason, extra: `**Total warnings:** ${count}` });
      const auto = await mod.escalate(member, count, i.user);
      await i.reply(`⚠️ Warned ${member} (warning #${count}).${auto ? ` ${auto}` : ''}`);
    },
  },

  {
    data: command('warnings', "See or remove a member's warnings", P.ModerateMembers)
      .addSubcommand((s) => s.setName('list').setDescription("Show a member's warnings")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove one warning by its number')
        .addIntegerOption((o) => o.setName('id').setDescription('Warning number from /warnings list').setRequired(true)))
      .addSubcommand((s) => s.setName('clear').setDescription("Remove all of a member's warnings")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
    execute: warnings,
  },

  {
    data: command('timeout', 'Stop a member from talking for a while', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d (max 28d)').setRequired(true))
      .addStringOption(reasonOption),
    async execute(i) {
      const member = i.options.getMember('user');
      const ms = parseDuration(i.options.getString('duration', true));
      if (!ms || ms > mod.MAX_TIMEOUT_MS) return i.reply(ephemeral('Use a duration like `10m`, `1h` or `2d`, up to 28 days.'));
      const error = mod.checkTarget(i.member, member, 'timeout');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      await member.timeout(ms, mod.auditReason(i.member, reason));
      await mod.notify(member.user, `🔇 You were timed out in **${i.guild.name}** for ${formatDuration(ms)}: ${reason}`);
      await mod.modLog(i.guild, { title: '🔇 Timeout', color: Colors.Orange, target: member.user, moderator: i.user, reason, extra: `**Until:** <t:${unix(Date.now() + ms)}:f>` });
      await i.reply(`🔇 ${member} is timed out until <t:${unix(Date.now() + ms)}:t>.`);
    },
  },

  {
    data: command('untimeout', 'Lift a timeout early', P.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    async execute(i) {
      const member = i.options.getMember('user');
      if (!member?.isCommunicationDisabled()) return i.reply(ephemeral("That member isn't timed out."));
      const error = mod.checkTarget(i.member, member, 'timeout');
      if (error) return i.reply(ephemeral(error));
      await member.timeout(null, mod.auditReason(i.member, 'Timeout lifted'));
      await mod.modLog(i.guild, { title: '🔊 Timeout lifted', color: Colors.Green, target: member.user, moderator: i.user });
      await i.reply(`🔊 ${member} can talk again.`);
    },
  },

  {
    data: command('kick', 'Remove a member from the server', P.KickMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption(reasonOption),
    async execute(i) {
      const member = i.options.getMember('user');
      const error = mod.checkTarget(i.member, member, 'kick');
      if (error) return i.reply(ephemeral(error));
      const reason = reasonOf(i);
      await mod.notify(member.user, `👢 You were kicked from **${i.guild.name}**: ${reason}`);
      await member.kick(mod.auditReason(i.member, reason));
      await mod.modLog(i.guild, { title: '👢 Kick', color: Colors.Orange, target: member.user, moderator: i.user, reason });
      await i.reply(`👢 Kicked **${member.user.tag}**.`);
    },
  },

  {
    data: command('ban', 'Ban a user, even one who already left', P.BanMembers)
      .addUserOption((o) => o.setName('user').setDescription('User or user ID').setRequired(true))
      .addStringOption(reasonOption)
      .addIntegerOption((o) => o.setName('delete_messages').setDescription('Also delete their recent messages')
        .addChoices({ name: 'Last hour', value: 3600 }, { name: 'Last day', value: 86_400 }, { name: 'Last 7 days', value: 604_800 })),
    async execute(i) {
      const user = i.options.getUser('user', true);
      const member = i.options.getMember('user');
      if (member) {
        const error = mod.checkTarget(i.member, member, 'ban');
        if (error) return i.reply(ephemeral(error));
      }
      const reason = reasonOf(i);
      if (member) await mod.notify(user, `🔨 You were banned from **${i.guild.name}**: ${reason}`);
      await i.guild.bans.create(user.id, {
        reason: mod.auditReason(i.member, reason),
        deleteMessageSeconds: i.options.getInteger('delete_messages') ?? 0,
      });
      await mod.modLog(i.guild, { title: '🔨 Ban', color: Colors.Red, target: user, moderator: i.user, reason });
      await i.reply(`🔨 Banned **${user.tag}**.`);
    },
  },

  {
    data: command('unban', 'Lift a ban', P.BanMembers)
      .addStringOption((o) => o.setName('user_id').setDescription('ID of the banned user').setRequired(true))
      .addStringOption(reasonOption),
    async execute(i) {
      const id = mod.parseIds(i.options.getString('user_id', true))[0];
      if (!id) return i.reply(ephemeral("That isn't a user ID."));
      const reason = reasonOf(i);
      const user = await i.guild.bans.remove(id, mod.auditReason(i.member, reason)).catch(() => null);
      if (!user) return i.reply(ephemeral("That user isn't banned."));
      await mod.modLog(i.guild, { title: '🕊️ Unban', color: Colors.Green, target: user, moderator: i.user, reason });
      await i.reply(`🕊️ Unbanned **${user.tag}**.`);
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
      await channel.setRateLimitPerUser(Math.round(ms / 1000), mod.auditReason(i.member, 'Slowmode'));
      await i.reply(ms ? `🐢 Slowmode in ${channel}: one message every ${Math.round(ms / 1000)}s.` : `🐇 Slowmode is off in ${channel}.`);
    },
  },
];
