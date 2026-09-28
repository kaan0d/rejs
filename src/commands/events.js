const { SlashCommandBuilder, EmbedBuilder, ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { db, getFeature, setFeature } = require('../db');
const { BRAND, ephemeral, parseDuration } = require('../util');
const giveaways = require('../giveaways');
const tempvoice = require('../tempvoice');
const journal = require('../journal');

const P = PermissionFlagsBits;
const unix = (ms) => Math.floor(ms / 1000);

async function giveaway(i) {
  const sub = i.options.getSubcommand();
  if (sub === 'start') {
    const ms = parseDuration(i.options.getString('duration', true));
    if (!ms || ms < 60_000 || ms > 60 * 86_400_000) return i.reply(ephemeral('Use a duration between `1m` and `60d`.'));
    const ageText = i.options.getString('min_account_age');
    const minAge = ageText ? parseDuration(ageText) : null;
    if (ageText && !minAge) return i.reply(ephemeral('Use an account age like `7d` or `4w`.'));
    const channel = i.options.getChannel('channel') ?? i.channel;
    if (!channel.permissionsFor(i.guild.members.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) return i.reply(ephemeral(`I can't post in ${channel}.`));

    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO giveaways (guild_id, channel_id, host_id, prize, winners, ends_at, required_role, min_age_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(i.guildId, channel.id, i.user.id, i.options.getString('prize', true), i.options.getInteger('winners') ?? 1,
      Date.now() + ms, i.options.getRole('required_role')?.id ?? null, minAge);
    const message = await channel.send(giveaways.giveawayMessage(giveaways.getGiveaway(id)));
    journal.created('message', message);
    db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(message.id, id);
    return i.reply(ephemeral(`Giveaway #${id} started in ${channel}: ${message.url}`));
  }

  if (sub === 'list') {
    const rows = db.prepare('SELECT * FROM giveaways WHERE guild_id = ? AND ended = 0 ORDER BY ends_at').all(i.guildId);
    return i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [new EmbedBuilder().setColor(BRAND).setTitle('Running giveaways')
        .setDescription(rows.map((g) => `\`#${g.id}\` **${g.prize}** in <#${g.channel_id}> · ends <t:${unix(g.ends_at)}:R>`).join('\n') || 'None.')],
    });
  }

  const g = giveaways.getGiveaway(i.options.getInteger('id', true));
  if (!g || g.guild_id !== i.guildId) return i.reply(ephemeral('There is no giveaway with that number here.'));
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  journal.refresh('giveaway', g.id);
  journal.cannotUndo('The winner announcement');
  if (sub === 'end') {
    if (g.ended) return i.editReply('That giveaway already ended. Use `/giveaway reroll` for new winners.');
    const winners = await giveaways.endGiveaway(i.client, g);
    return i.editReply(`✅ Ended early. ${winners?.length ? `Winners: ${winners.map((w) => `<@${w}>`).join(', ')}` : 'Nobody eligible entered.'}`);
  }
  if (!g.ended) return i.editReply('That giveaway is still running. End it first with `/giveaway end`.');
  const winners = await giveaways.endGiveaway(i.client, g, { reroll: i.options.getInteger('winners') ?? 1 });
  return i.editReply(winners.length ? `✅ New winner${winners.length === 1 ? '' : 's'}: ${winners.map((w) => `<@${w}>`).join(', ')}` : 'Nobody else is eligible.');
}

// Every /voice subcommand works on the temporary channel the member is sitting in.
async function voice(i) {
  const sub = i.options.getSubcommand();
  const channel = i.member.voice.channel;
  const row = channel && tempvoice.tempChannel(channel.id);
  if (!row) return i.reply(ephemeral('Join your temporary voice channel first.'));

  if (sub === 'claim') {
    if (row.owner_id === i.user.id) return i.reply(ephemeral('This channel is already yours.'));
    if (channel.members.has(row.owner_id)) return i.reply(ephemeral(`<@${row.owner_id}> is still here, so the channel is theirs.`));
    tempvoice.setOwner(channel.id, i.user.id);
    return i.reply(ephemeral('The channel is yours now.'));
  }
  if (row.owner_id !== i.user.id) return i.reply(ephemeral(`Only <@${row.owner_id}> can change this channel. If they left, use \`/voice claim\`.`));

  const everyone = i.guild.roles.everyone;
  const user = i.options.getUser('user');
  const reason = `Temp voice: ${i.user.tag}`;
  try {
    switch (sub) {
      case 'rename':
        await channel.setName(i.options.getString('name', true), reason);
        return i.reply(ephemeral('✅ Renamed.'));
      case 'limit': {
        const limit = i.options.getInteger('users', true);
        await channel.setUserLimit(limit, reason);
        return i.reply(ephemeral(limit ? `✅ Limit set to ${limit}.` : '✅ No limit.'));
      }
      case 'lock':
      case 'unlock':
        await channel.permissionOverwrites.edit(everyone, { Connect: sub === 'lock' ? false : null }, { reason });
        await channel.permissionOverwrites.edit(i.user.id, { Connect: true, ViewChannel: true }, { reason });
        return i.reply(ephemeral(sub === 'lock' ? 'Locked. Let people in with `/voice allow`.' : 'Unlocked.'));
      case 'hide':
      case 'unhide':
        await channel.permissionOverwrites.edit(everyone, { ViewChannel: sub === 'hide' ? false : null }, { reason });
        await channel.permissionOverwrites.edit(i.user.id, { Connect: true, ViewChannel: true }, { reason });
        return i.reply(ephemeral(sub === 'hide' ? 'Hidden.' : 'Visible again.'));
      case 'allow':
        await channel.permissionOverwrites.edit(user.id, { Connect: true, ViewChannel: true }, { reason });
        return i.reply(ephemeral(`✅ ${user} can join now.`));
      case 'kick': {
        if (user.id === i.user.id) return i.reply(ephemeral("You can't kick yourself."));
        await channel.permissionOverwrites.edit(user.id, { Connect: false }, { reason });
        const target = channel.members.get(user.id);
        await target?.voice.disconnect(reason);
        return i.reply(ephemeral(`${user} was removed and can't rejoin.`));
      }
      case 'transfer':
        if (!channel.members.has(user.id) || user.bot) return i.reply(ephemeral('They need to be in the channel.'));
        tempvoice.setOwner(channel.id, user.id);
        return i.reply(ephemeral(`${user} owns the channel now.`));
    }
  } catch (e) {
    // Discord allows only 2 channel renames per 10 minutes.
    return i.reply(ephemeral(e.status === 429 || /rate/i.test(e.message) ? 'Discord only allows 2 renames every 10 minutes. Try again later.' : `❌ ${e.message}`));
  }
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Run giveaways with a button to enter')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(P.ManageGuild)
      .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('prize').setDescription('What they win').setMaxLength(200).setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('e.g. 1h, 3d').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many winners (default 1)').setMinValue(1).setMaxValue(50))
        .addChannelOption((o) => o.setName('channel').setDescription('Default: this channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('required_role').setDescription('Only members with this role can enter'))
        .addStringOption((o) => o.setName('min_account_age').setDescription('Keep alt accounts out, e.g. 14d')))
      .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now and draw winners')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway number').setRequired(true)))
      .addSubcommand((s) => s.setName('reroll').setDescription('Draw new winners for an ended giveaway')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway number').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many new winners (default 1)').setMinValue(1).setMaxValue(50)))
      .addSubcommand((s) => s.setName('list').setDescription('Show running giveaways')),
    execute: giveaway,
  },

  {
    data: new SlashCommandBuilder()
      .setName('tempvoice')
      .setDescription('Let members create their own voice channels')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(P.ManageChannels)
      .addSubcommand((s) => s.setName('setup').setDescription('Create the "join to create" channel')
        .addChannelOption((o) => o.setName('category').setDescription('Category for the new channels').addChannelTypes(ChannelType.GuildCategory)))
      .addSubcommand((s) => s.setName('off').setDescription('Stop creating temporary channels')),
    async execute(i) {
      if (i.options.getSubcommand() === 'off') {
        setFeature(i.guildId, 'tempvoice', {});
        return i.reply(ephemeral('✅ Temporary channels are off. You can delete the hub channel.'));
      }
      if (!i.guild.members.me.permissions.has([P.ManageChannels, P.MoveMembers])) return i.reply(ephemeral('I need Manage Channels and Move Members.'));
      const old = i.guild.channels.cache.get(getFeature(i.guildId, 'tempvoice', {}).hubId);
      const hub = await i.guild.channels.create({
        name: 'Create a channel', type: ChannelType.GuildVoice, parent: i.options.getChannel('category')?.id ?? null, reason: 'Temp voice hub',
      });
      journal.created('channel', hub);
      setFeature(i.guildId, 'tempvoice', { hubId: hub.id });
      return i.reply(ephemeral(`✅ Joining ${hub} now creates a personal voice channel.${old ? ` The old hub ${old} no longer works; you can delete it.` : ''} Owners manage it with \`/voice\`.`));
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('voice')
      .setDescription('Control your temporary voice channel')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('rename').setDescription('Rename your channel')
        .addStringOption((o) => o.setName('name').setDescription('New name').setMaxLength(100).setRequired(true)))
      .addSubcommand((s) => s.setName('limit').setDescription('Set how many people can join')
        .addIntegerOption((o) => o.setName('users').setDescription('0 = no limit').setMinValue(0).setMaxValue(99).setRequired(true)))
      .addSubcommand((s) => s.setName('lock').setDescription('Stop new people joining'))
      .addSubcommand((s) => s.setName('unlock').setDescription('Let anyone join again'))
      .addSubcommand((s) => s.setName('hide').setDescription('Hide your channel'))
      .addSubcommand((s) => s.setName('unhide').setDescription('Show your channel again'))
      .addSubcommand((s) => s.setName('allow').setDescription('Let someone in while locked or hidden')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
      .addSubcommand((s) => s.setName('kick').setDescription('Remove someone and stop them rejoining')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
      .addSubcommand((s) => s.setName('transfer').setDescription('Give the channel to someone in it')
        .addUserOption((o) => o.setName('user').setDescription('New owner').setRequired(true)))
      .addSubcommand((s) => s.setName('claim').setDescription('Take over the channel after the owner left')),
    execute: voice,
  },
];
