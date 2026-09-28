const {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, ChannelType,
  InteractionContextType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { db, setFeature } = require('../db');
const { BRAND, ephemeral } = require('../util');
const tickets = require('../tickets');
const reports = require('../reports');
const journal = require('../journal');

const P = PermissionFlagsBits;
const TEXT_CHANNELS = [ChannelType.GuildText];
const THREAD_PERMISSIONS = [P.ViewChannel, P.SendMessages, P.CreatePrivateThreads, P.SendMessagesInThreads, P.ManageThreads, P.EmbedLinks];

async function ticketCommand(i) {
  const sub = i.options.getSubcommand();
  const cfg = tickets.settings(i.guildId);
  const setup = ['category-add', 'category-remove', 'panel', 'settings'];
  if (setup.includes(sub) && !i.memberPermissions.has(P.ManageGuild)) return i.reply(ephemeral('Setting up tickets needs Manage Server.'));

  if (sub === 'category-add') {
    const label = i.options.getString('label', true).trim();
    const id = tickets.slug(label);
    if (cfg.categories.length >= 25) return i.reply(ephemeral('You can have up to 25 ticket types.'));
    if (cfg.categories.some((c) => c.id === id)) return i.reply(ephemeral(`There is already a "${label}" ticket type.`));
    const role = i.options.getRole('staff_role');
    cfg.categories.push({ id, label, roleId: role?.id ?? null, emoji: i.options.getString('emoji') });
    setFeature(i.guildId, 'tickets', cfg);
    const mentionNote = role && !role.mentionable && !i.guild.members.me.permissions.has(P.MentionEveryone)
      ? `\n⚠️ ${role} can't be mentioned by me, so its members won't be added to tickets. Make it mentionable or give me Mention Everyone.`
      : '';
    return i.reply(ephemeral(`✅ Added "${label}". Post or refresh the panel with \`/ticket panel\`.${mentionNote}`));
  }

  if (sub === 'category-remove') {
    const id = tickets.slug(i.options.getString('label', true));
    const next = cfg.categories.filter((c) => c.id !== id);
    if (next.length === cfg.categories.length) return i.reply(ephemeral("There's no ticket type with that name."));
    setFeature(i.guildId, 'tickets', { ...cfg, categories: next });
    return i.reply(ephemeral('✅ Removed. Refresh the panel with `/ticket panel`.'));
  }

  if (sub === 'panel') {
    if (!cfg.categories.length) return i.reply(ephemeral('Add a ticket type first with `/ticket category-add`.'));
    const channel = i.options.getChannel('channel', true);
    if (!channel.permissionsFor(i.guild.members.me)?.has(THREAD_PERMISSIONS)) {
      return i.reply(ephemeral(`In ${channel} I need View Channel, Send Messages, Create Private Threads, Send Messages in Threads, Manage Threads and Embed Links.`));
    }
    const panel = await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(BRAND)
        .setTitle(i.options.getString('title') ?? '🎫 Support')
        .setDescription(i.options.getString('message') ?? 'Need help? Pick a topic below. A private thread opens where only you and staff can talk.')],
      components: tickets.panelRows(cfg.categories),
    });
    journal.created('message', panel);
    return i.reply(ephemeral(`✅ Panel posted in ${channel}. Tickets open as private threads there.`));
  }

  if (sub === 'settings') {
    const log = i.options.getChannel('log_channel');
    const hours = i.options.getInteger('inactive_hours');
    if (log) cfg.logChannelId = log.id;
    if (hours !== null) cfg.inactiveHours = hours;
    setFeature(i.guildId, 'tickets', cfg);
    return i.reply(ephemeral([
      `Transcripts go to: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'nowhere yet (set log_channel)'}`,
      `Auto-close: ${cfg.inactiveHours ? `warn after ${cfg.inactiveHours}h of silence, close 24h later` : 'off'}`,
      `Types: ${cfg.categories.map((c) => `${c.emoji ?? ''}${c.label}${c.roleId ? ` → <@&${c.roleId}>` : ''}`).join(', ') || 'none'}`,
    ].join('\n')));
  }

  if (sub === 'stats') {
    const row = db.prepare(`SELECT
      SUM(status = 'open') AS open, SUM(status = 'closed') AS closed,
      AVG(rating) AS avg, COUNT(rating) AS rated FROM tickets WHERE guild_id = ?`).get(i.guildId);
    const staff = db.prepare("SELECT claimed_by, COUNT(*) AS n, AVG(rating) AS avg FROM tickets WHERE guild_id = ? AND claimed_by IS NOT NULL GROUP BY claimed_by ORDER BY n DESC LIMIT 10").all(i.guildId);
    const stars = (avg) => (avg ? `${avg.toFixed(1)}⭐` : 'no ratings');
    return i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [new EmbedBuilder()
        .setColor(BRAND)
        .setTitle('🎫 Ticket stats')
        .addFields(
          { name: 'Open', value: `${row.open ?? 0}`, inline: true },
          { name: 'Closed', value: `${row.closed ?? 0}`, inline: true },
          { name: 'Rating', value: `${stars(row.avg)} (${row.rated} ratings)`, inline: true },
          { name: 'Top staff', value: staff.map((s) => `<@${s.claimed_by}> · ${s.n} tickets · ${stars(s.avg)}`).join('\n') || 'Nobody has claimed a ticket yet.' },
        )],
    });
  }

  // add / remove: only inside an open ticket, by its staff.
  const ticket = db.prepare("SELECT * FROM tickets WHERE thread_id = ? AND status = 'open'").get(i.channelId);
  if (!ticket) return i.reply(ephemeral('Use this inside an open ticket.'));
  const category = cfg.categories.find((c) => c.id === ticket.category);
  if (!tickets.isStaff(i.member, category)) return i.reply(ephemeral('Only staff can change who is in a ticket.'));
  const user = i.options.getUser('user', true);
  if (sub === 'add') {
    await i.channel.members.add(user.id);
    journal.threadMember(i.channel, user.id, true);
    return i.reply(`➕ Added ${user} to this ticket.`);
  }
  if (user.id === ticket.user_id) return i.reply(ephemeral("You can't remove the member who opened the ticket. Close it instead."));
  await i.channel.members.remove(user.id);
  journal.threadMember(i.channel, user.id, false);
  return i.reply(`➖ Removed ${user} from this ticket.`);
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Set up and manage support tickets')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(P.ManageThreads)
      .addSubcommand((s) => s.setName('category-add').setDescription('Add a ticket type (a button on the panel)')
        .addStringOption((o) => o.setName('label').setDescription('e.g. Support, Report a player, Ban appeal').setMaxLength(40).setRequired(true))
        .addRoleOption((o) => o.setName('staff_role').setDescription('Staff role added to these tickets'))
        .addStringOption((o) => o.setName('emoji').setDescription('Button emoji, e.g. 🛠️').setMaxLength(40)))
      .addSubcommand((s) => s.setName('category-remove').setDescription('Remove a ticket type')
        .addStringOption((o) => o.setName('label').setDescription('Name of the ticket type').setRequired(true)))
      .addSubcommand((s) => s.setName('panel').setDescription('Post the ticket panel. Tickets open as private threads in this channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel for the panel').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addStringOption((o) => o.setName('title').setDescription('Panel title').setMaxLength(256))
        .addStringOption((o) => o.setName('message').setDescription('Panel text').setMaxLength(2000)))
      .addSubcommand((s) => s.setName('settings').setDescription('Transcript channel and auto-close')
        .addChannelOption((o) => o.setName('log_channel').setDescription('Where transcripts go').addChannelTypes(...TEXT_CHANNELS))
        .addIntegerOption((o) => o.setName('inactive_hours').setDescription('Warn after this many quiet hours, close a day later (0 = never)').setMinValue(0).setMaxValue(720)))
      .addSubcommand((s) => s.setName('stats').setDescription('Ticket counts and ratings'))
      .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))),
    execute: ticketCommand,
  },

  {
    data: new SlashCommandBuilder()
      .setName('report')
      .setDescription('Report a member to the staff')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('What happened').setMaxLength(500).setRequired(true)),
    async execute(i) {
      const error = await reports.createReport(i.guild, i.user, i.options.getUser('user', true), i.options.getString('reason', true));
      await i.reply(ephemeral(error ?? '✅ Thanks. Your report was sent to the staff.'));
    },
  },

  {
    data: new ContextMenuCommandBuilder()
      .setName('Report message')
      .setType(ApplicationCommandType.Message)
      .setContexts(InteractionContextType.Guild),
    execute: reports.reportMessage,
  },
];
