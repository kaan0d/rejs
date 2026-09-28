const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits, AttachmentBuilder, Events, MessageFlags,
} = require('discord.js');
const { db, getFeature } = require('./db');
const { BRAND, ephemeral } = require('./util');
const { formatDuration } = require('./monitor');
const { transcriptHtml, fetchAll } = require('./transcript');

const DEFAULTS = { logChannelId: null, inactiveHours: 48, categories: [] };
const CLOSE_AFTER_WARNING_MS = 24 * 3_600_000;
const unix = (ms) => Math.floor(ms / 1000);

const settings = (guildId) => getFeature(guildId, 'tickets', DEFAULTS);
const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ticket';
const getTicket = (id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(id));
const openTicketOf = (guildId, userId) =>
  db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'").get(guildId, userId);

const isStaff = (member, category) =>
  member.permissions.has(PermissionFlagsBits.ManageThreads) || Boolean(category?.roleId && member.roles.cache.has(category.roleId));

// One button per category, five to a row.
function panelRows(categories) {
  const rows = [];
  for (let n = 0; n < categories.length; n += 5) {
    rows.push(new ActionRowBuilder().addComponents(categories.slice(n, n + 5).map((c) => {
      const button = new ButtonBuilder().setCustomId(`ticket-open:${c.id}`).setLabel(c.label).setStyle(ButtonStyle.Primary);
      return c.emoji ? button.setEmoji(c.emoji) : button;
    })));
  }
  return rows;
}

const ticketButtons = (id, claimedBy) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`ticket-claim:${id}`).setStyle(ButtonStyle.Secondary).setEmoji('🙋')
    .setLabel(claimedBy ? `Claimed by ${claimedBy}`.slice(0, 80) : 'Claim').setDisabled(Boolean(claimedBy)),
  new ButtonBuilder().setCustomId(`ticket-close:${id}`).setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
);

const ratingRow = (id) => new ActionRowBuilder().addComponents([1, 2, 3, 4, 5].map((n) =>
  new ButtonBuilder().setCustomId(`ticket-rate:${id}-${n}`).setLabel('⭐'.repeat(n)).setStyle(ButtonStyle.Secondary)));

// Saves a transcript to the ticket log, asks the member for a rating, and archives the thread.
async function closeTicket(client, ticket, closer, reason) {
  const { changes } = db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(Date.now(), ticket.id);
  if (!changes) return false;

  const guild = client.guilds.cache.get(ticket.guild_id);
  const category = settings(ticket.guild_id).categories.find((c) => c.id === ticket.category);
  const thread = await client.channels.fetch(ticket.thread_id).catch(() => null);
  const opener = await client.users.fetch(ticket.user_id).catch(() => null);
  const messages = thread ? await fetchAll(thread).catch(() => []) : [];
  const label = category?.label ?? ticket.category;

  const html = transcriptHtml({
    title: `Ticket #${ticket.id} · ${label}`,
    subtitle: `Opened by ${opener?.tag ?? ticket.user_id} · closed by ${closer.tag}${reason ? ` (${reason})` : ''} · ${messages.length} messages`,
    messages,
  });
  const file = () => new AttachmentBuilder(Buffer.from(html), { name: `ticket-${ticket.id}.html` });

  const summary = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`🎫 Ticket #${ticket.id} closed · ${label}`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.user_id}>`, inline: true },
      { name: 'Claimed by', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : '—', inline: true },
      { name: 'Closed by', value: `${closer}`, inline: true },
      { name: 'Open for', value: formatDuration(Date.now() - ticket.created_at), inline: true },
      { name: 'Reason', value: ticket.reason.slice(0, 1024) },
    )
    .setTimestamp();
  if (reason) summary.addFields({ name: 'Close reason', value: reason });
  const log = guild?.channels.cache.get(settings(ticket.guild_id).logChannelId);
  await log?.send({ embeds: [summary], files: [file()], allowedMentions: { parse: [] } }).catch(() => {});

  await opener?.send({
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`Your ticket in ${guild?.name ?? 'the server'} was closed`)
      .setDescription('The transcript is attached. How did we do?')],
    files: [file()],
    components: [ratingRow(ticket.id)],
  }).catch(() => {});

  if (thread) {
    await thread.send(`🔒 Ticket closed by ${closer}${reason ? `: ${reason}` : '.'}`).catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  return true;
}

// Warns quiet tickets, then closes them a day later. Called by the scheduler.
async function checkInactive(client) {
  const now = Date.now();
  for (const t of db.prepare("SELECT * FROM tickets WHERE status = 'open'").all()) {
    const hours = settings(t.guild_id).inactiveHours;
    if (!hours) continue;
    if (!t.warned_at && t.last_activity < now - hours * 3_600_000) {
      db.prepare('UPDATE tickets SET warned_at = ? WHERE id = ?').run(now, t.id);
      const thread = await client.channels.fetch(t.thread_id).catch(() => null);
      await thread?.send(`⏰ <@${t.user_id}>, this ticket has been quiet for ${hours} hours. It closes <t:${unix(now + CLOSE_AFTER_WARNING_MS)}:R> unless someone replies.`).catch(() => {});
    } else if (t.warned_at && t.warned_at < now - CLOSE_AFTER_WARNING_MS) {
      await closeTicket(client, t, client.user, 'No activity');
    }
  }
}

const handlers = {
  async 'ticket-open'(i, categoryId) {
    const category = settings(i.guildId).categories.find((c) => c.id === categoryId);
    if (!category) return i.reply(ephemeral('This ticket type no longer exists.'));
    const existing = openTicketOf(i.guildId, i.user.id);
    if (existing) return i.reply(ephemeral(`You already have an open ticket: <#${existing.thread_id}>`));
    await i.showModal(new ModalBuilder()
      .setCustomId(`ticket-form:${categoryId}`)
      .setTitle(category.label.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('What do you need help with?')
        .setStyle(TextInputStyle.Paragraph)
        .setMinLength(5)
        .setMaxLength(1000))));
  },

  async 'ticket-form'(i, categoryId) {
    const category = settings(i.guildId).categories.find((c) => c.id === categoryId);
    if (!category) return i.reply(ephemeral('This ticket type no longer exists.'));
    const existing = openTicketOf(i.guildId, i.user.id);
    if (existing) return i.reply(ephemeral(`You already have an open ticket: <#${existing.thread_id}>`));

    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = i.fields.getTextInputValue('reason');
    const thread = await i.channel.threads.create({
      name: `${category.label}-${i.user.username}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 10080,
      reason: `Ticket by ${i.user.tag}`,
    }).catch(() => null);
    if (!thread) return i.editReply("❌ I couldn't open a private thread here. Staff need to give me Create Private Threads and Manage Threads.");

    const now = Date.now();
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO tickets (guild_id, thread_id, user_id, category, reason, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(i.guildId, thread.id, i.user.id, category.id, reason, now, now);
    await thread.members.add(i.user.id);
    // Mentioning the staff role adds its members to the private thread.
    await thread.send({
      content: `${i.user}${category.roleId ? ` <@&${category.roleId}>` : ''}`,
      embeds: [new EmbedBuilder()
        .setColor(BRAND)
        .setTitle(`${category.emoji ?? '🎫'} ${category.label} · ticket #${id}`)
        .setDescription(reason)
        .setFooter({ text: 'Staff will be with you soon. Close the ticket when you are done.' })],
      components: [ticketButtons(id)],
      allowedMentions: { users: [i.user.id], roles: category.roleId ? [category.roleId] : [] },
    });
    await i.editReply(`✅ Your ticket is open: ${thread}`);
  },

  async 'ticket-claim'(i, id) {
    const ticket = getTicket(id);
    if (!ticket || ticket.status !== 'open') return i.reply(ephemeral('This ticket is closed.'));
    const category = settings(i.guildId).categories.find((c) => c.id === ticket.category);
    if (!isStaff(i.member, category)) return i.reply(ephemeral('Only staff can claim tickets.'));
    if (ticket.claimed_by) return i.reply(ephemeral(`<@${ticket.claimed_by}> already claimed this ticket.`));
    db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(i.user.id, ticket.id);
    await i.update({ components: [ticketButtons(ticket.id, i.member.displayName)] });
    await i.channel.send(`🙋 ${i.user} is handling this ticket.`);
  },

  async 'ticket-close'(i, id) {
    const ticket = getTicket(id);
    if (!ticket || ticket.status !== 'open') return i.reply(ephemeral('This ticket is already closed.'));
    const category = settings(i.guildId).categories.find((c) => c.id === ticket.category);
    if (ticket.user_id !== i.user.id && !isStaff(i.member, category)) return i.reply(ephemeral('Only the member who opened it or staff can close this ticket.'));
    await i.reply(ephemeral('🔒 Closing and saving the transcript…'));
    await closeTicket(i.client, ticket, i.user, null);
  },

  async 'ticket-rate'(i, arg) {
    const [id, stars] = arg.split('-').map(Number);
    const ticket = getTicket(id);
    if (!ticket || ticket.user_id !== i.user.id) return i.reply(ephemeral("You can't rate this ticket."));
    if (ticket.rating) return i.update({ components: [] });
    db.prepare('UPDATE tickets SET rating = ? WHERE id = ?').run(stars, id);
    await i.update({ content: `Thanks for rating us ${'⭐'.repeat(stars)}!`, components: [] });
  },
};

function register(client) {
  // Any message in a ticket thread counts as activity and cancels a pending auto-close.
  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot || !message.channel.isThread()) return;
    db.prepare("UPDATE tickets SET last_activity = ?, warned_at = NULL WHERE thread_id = ? AND status = 'open'").run(Date.now(), message.channelId);
  });
}

module.exports = { DEFAULTS, settings, slug, panelRows, closeTicket, checkInactive, handlers, register, isStaff, getTicket };
