const {
  SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, ChannelType, escapeMarkdown,
} = require('discord.js');
const { db } = require('../db');
const { BRAND } = require('../util');
const mod = require('../moderation');

const unix = (ms) => Math.floor(ms / 1000);
const NEW_ACCOUNT_MS = 7 * 86_400_000;

function roleList(member) {
  const roles = member.roles.cache.filter((r) => r.id !== member.guild.id).sort((a, b) => b.position - a.position);
  const shown = roles.first(15).join(' ');
  return roles.size > 15 ? `${shown} +${roles.size - 15} more` : shown || 'None';
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('About a member or user')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Default: you')),
    async execute(i) {
      const user = await (i.options.getUser('user') ?? i.user).fetch();
      const member = i.options.getMember('user') ?? (i.options.getUser('user') ? null : i.member);
      const young = Date.now() - user.createdTimestamp < NEW_ACCOUNT_MS ? ' ' : '';

      const embed = new EmbedBuilder()
        .setColor(user.accentColor ?? BRAND)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .setThumbnail((member ?? user).displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'User', value: `${user}\n\`${user.id}\``, inline: true },
          { name: 'Account created', value: `<t:${unix(user.createdTimestamp)}:D>\n<t:${unix(user.createdTimestamp)}:R>${young}`, inline: true },
        );
      if (member) {
        embed.addFields(
          { name: 'Joined', value: `<t:${unix(member.joinedTimestamp)}:D>\n<t:${unix(member.joinedTimestamp)}:R>`, inline: true },
          { name: 'Roles', value: roleList(member) },
        );
        if (member.isCommunicationDisabled()) {
          embed.addFields({ name: 'Timed out', value: `Until <t:${unix(member.communicationDisabledUntilTimestamp)}:f>` });
        }
      } else {
        embed.setFooter({ text: 'Not in this server' });
      }

      // Staff also see the record, without it showing to everyone else.
      if (i.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        const total = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE guild_id = ? AND user_id = ? AND action != 'note'").get(i.guildId, user.id).n;
        embed.addFields({ name: 'Record', value: `${mod.activeWarnings(i.guildId, user.id)} active warnings · ${total} cases · see \`/history\`` });
        return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      await i.reply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('serverinfo')
      .setDescription('About this server')
      .setContexts(InteractionContextType.Guild),
    async execute(i) {
      const g = i.guild;
      const channels = g.channels.cache;
      const count = (...types) => channels.filter((c) => types.includes(c.type)).size;
      await i.reply({
        embeds: [new EmbedBuilder()
          .setColor(BRAND)
          .setTitle(escapeMarkdown(g.name))
          .setThumbnail(g.iconURL({ size: 256 }))
          .setDescription(g.description ?? null)
          .addFields(
            { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
            { name: 'Created', value: `<t:${unix(g.createdTimestamp)}:D>\n<t:${unix(g.createdTimestamp)}:R>`, inline: true },
            { name: 'Members', value: `${g.memberCount}`, inline: true },
            { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (level ${g.premiumTier})`, inline: true },
            { name: 'Channels', value: `${count(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)} text · ${count(ChannelType.GuildVoice, ChannelType.GuildStageVoice)} voice`, inline: true },
            { name: 'Roles', value: `${g.roles.cache.size - 1}`, inline: true },
            { name: 'Emojis', value: `${g.emojis.cache.size}`, inline: true },
            { name: 'Verification', value: ['None', 'Low', 'Medium', 'High', 'Highest'][g.verificationLevel], inline: true },
          )
          .setFooter({ text: `ID ${g.id}` })],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription("Show someone's avatar and banner in full size")
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Default: you')),
    async execute(i) {
      const user = await (i.options.getUser('user') ?? i.user).fetch();
      const member = i.options.getMember('user') ?? (i.options.getUser('user') ? null : i.member);
      const avatar = user.displayAvatarURL({ size: 1024 });
      const serverAvatar = member?.avatar ? member.displayAvatarURL({ size: 1024 }) : null;
      const banner = user.bannerURL({ size: 1024 });

      const links = [`[Avatar](${avatar})`, serverAvatar && `[Server avatar](${serverAvatar})`, banner && `[Banner](${banner})`].filter(Boolean);
      const embeds = [new EmbedBuilder()
        .setColor(user.accentColor ?? BRAND)
        .setAuthor({ name: user.tag })
        .setDescription(links.join(' · '))
        .setImage(serverAvatar ?? avatar)];
      if (banner) embeds.push(new EmbedBuilder().setColor(user.accentColor ?? BRAND).setImage(banner));
      await i.reply({ embeds });
    },
  },
];
