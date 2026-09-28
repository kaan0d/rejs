const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Colors,
  PermissionFlagsBits,
} = require('discord.js');
const { db, getSettings } = require('./db');
const { BRAND, ephemeral } = require('./util');
const mod = require('./moderation');

const unix = (ms) => Math.floor(ms / 1000);

// Button for the ban DM. Only shown when the server has an appeals channel.
function appealRow(guildId) {
  if (!getSettings(guildId).appeals_channel_id) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:${guildId}`).setLabel('Appeal this ban').setEmoji('📨').setStyle(ButtonStyle.Primary),
  )];
}

const latestBan = (guildId, userId) =>
  db.prepare("SELECT * FROM cases WHERE guild_id = ? AND user_id = ? AND action = 'ban' ORDER BY number DESC LIMIT 1").get(guildId, userId);

// A single-use invite so accepted members can find their way back.
async function makeInvite(guild) {
  const channel = guild.systemChannel ?? guild.channels.cache.find((c) => c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite));
  const invite = await channel?.createInvite({ maxUses: 1, maxAge: 7 * 86_400, unique: true, reason: 'Ban appeal accepted' }).catch(() => null);
  return invite?.url;
}

async function decide(i, appealId, accept) {
  if (!i.memberPermissions?.has(PermissionFlagsBits.BanMembers)) return i.reply(ephemeral('You need the Ban Members permission to decide appeals.'));
  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(Number(appealId));
  if (!appeal || appeal.guild_id !== i.guildId || appeal.status !== 'pending') return i.reply(ephemeral('This appeal was already decided.'));
  db.prepare('UPDATE appeals SET status = ? WHERE id = ?').run(accept ? 'accepted' : 'denied', appeal.id);

  const user = await i.client.users.fetch(appeal.user_id);
  if (accept) {
    await i.guild.bans.remove(user.id, mod.auditReason(i.member, 'Ban appeal accepted')).catch(() => {});
    mod.closeBans(i.guildId, user.id);
    await mod.recordCase(i.guild, { action: 'unban', user, moderator: i.user, reason: `Appeal accepted (ban case #${appeal.case_number})` });
    const invite = await makeInvite(i.guild);
    await mod.notify(user, `🕊️ Your appeal to **${i.guild.name}** was accepted.${invite ? ` You can rejoin here: ${invite}` : ' You can rejoin.'}`);
  } else {
    await mod.notify(user, `Your ban appeal to **${i.guild.name}** was denied.`);
  }

  const embed = EmbedBuilder.from(i.message.embeds[0])
    .setColor(accept ? Colors.Green : Colors.Red)
    .setFooter({ text: `${accept ? 'Accepted' : 'Denied'} by ${i.user.tag}` });
  await i.update({ embeds: [embed], components: [] });
}

// Keyed by the part of the custom ID before the colon. Custom IDs carry their own data,
// so these buttons keep working after a restart.
const handlers = {
  async appeal(i, guildId) {
    const ban = latestBan(guildId, i.user.id);
    if (!ban) return i.reply(ephemeral('There is no ban on record to appeal.'));
    if (db.prepare('SELECT 1 FROM appeals WHERE guild_id = ? AND case_number = ?').get(guildId, ban.number)) {
      return i.reply(ephemeral('You already appealed this ban. You will get a DM when staff decide.'));
    }
    await i.showModal(new ModalBuilder()
      .setCustomId(`appeal-form:${guildId}`)
      .setTitle('Ban appeal')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('text')
        .setLabel('Why should you be unbanned?')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(20)
        .setMaxLength(1500))));
  },

  async 'appeal-form'(i, guildId) {
    const guild = i.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(getSettings(guildId).appeals_channel_id);
    if (!channel) return i.reply(ephemeral('This server is not taking appeals right now.'));
    if (!(await guild.bans.fetch(i.user.id).catch(() => null))) return i.reply(ephemeral("You're not banned anymore, so you can just rejoin."));

    const ban = latestBan(guildId, i.user.id);
    const text = i.fields.getTextInputValue('text');
    let appealId;
    try {
      ({ lastInsertRowid: appealId } = db.prepare('INSERT INTO appeals (guild_id, case_number, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, ban.number, i.user.id, text, Date.now()));
    } catch {
      return i.reply(ephemeral('You already appealed this ban.'));
    }

    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(BRAND)
        .setAuthor({ name: `Ban appeal · ${i.user.tag}`, iconURL: i.user.displayAvatarURL() })
        .setDescription(text)
        .addFields(
          { name: 'User', value: `${i.user} (\`${i.user.id}\`)`, inline: true },
          { name: 'Ban', value: `Case #${ban.number}, <t:${unix(ban.created_at)}:R>`, inline: true },
          { name: 'Ban reason', value: ban.reason },
        )
        .setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`appeal-accept:${appealId}`).setLabel('Accept and unban').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`appeal-deny:${appealId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      )],
      allowedMentions: { parse: [] },
    });
    await i.reply(ephemeral('📨 Your appeal was sent. You will get a DM when staff decide.'));
  },

  'appeal-accept': (i, id) => decide(i, id, true),
  'appeal-deny': (i, id) => decide(i, id, false),
};

module.exports = { appealRow, handlers };
