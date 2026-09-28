const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags,
  PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { db } = require('../db');
const { BRAND, ephemeral } = require('../util');
const mod = require('../moderation');

const PAGE_SIZE = 10;
const unix = (ms) => Math.floor(ms / 1000);

const command = (name, description, permission) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(permission);

async function history(i) {
  const user = i.options.getUser('user', true);
  const rows = db.prepare('SELECT * FROM cases WHERE guild_id = ? AND user_id = ? ORDER BY number DESC').all(i.guildId, user.id);
  if (!rows.length) return i.reply(ephemeral(`${user} has a clean record.`));

  const counts = {};
  for (const c of rows) counts[c.action] = (counts[c.action] ?? 0) + 1;
  const summary = Object.entries(counts).map(([action, n]) => `${mod.ACTIONS[action].emoji} ${n}`).join('  ');
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  let page = 0;

  const render = () => {
    const lines = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((c) => {
      const a = mod.ACTIONS[c.action];
      const struck = c.active ? '' : '~~';
      return `${a.emoji} \`#${c.number}\` ${struck}**${a.label}**${struck} <t:${unix(c.created_at)}:R> by <@${c.moderator_id}>\n${escapeMarkdown(c.reason)}`;
    });
    const embed = new EmbedBuilder()
      .setColor(BRAND)
      .setAuthor({ name: `${user.tag} · ${rows.length} case${rows.length === 1 ? '' : 's'}`, iconURL: user.displayAvatarURL() })
      .setDescription(`${summary}\n\n${lines.join('\n\n')}`)
      .setFooter({ text: `Page ${page + 1}/${pages} · crossed out = removed or lifted` });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
    );
    return { embeds: [embed], components: pages > 1 ? [buttons] : [], flags: MessageFlags.Ephemeral };
  };

  const response = await i.reply(render());
  if (pages === 1) return;
  const collector = response.createMessageComponentCollector({ time: 300_000 });
  collector.on('collect', async (button) => {
    page += button.customId === 'next' ? 1 : -1;
    await button.update(render());
  });
  collector.on('end', () => i.editReply({ components: [] }).catch(() => {}));
}

async function caseCommand(i) {
  const number = i.options.getInteger('number', true);
  const c = mod.getCase(i.guildId, number);
  if (!c) return i.reply(ephemeral(`There is no case #${number}.`));

  if (i.options.getSubcommand() === 'reason') {
    const reason = i.options.getString('reason', true);
    db.prepare('UPDATE cases SET reason = ? WHERE id = ?').run(reason, c.id);
    return i.reply({ content: `✅ Updated the reason for case #${number}.`, embeds: [mod.caseEmbed({ ...c, reason })], flags: MessageFlags.Ephemeral });
  }
  return i.reply({ embeds: [mod.caseEmbed(c)], flags: MessageFlags.Ephemeral });
}

async function note(i) {
  if (i.options.getSubcommand() === 'remove') {
    const number = i.options.getInteger('case', true);
    const { changes } = db.prepare("DELETE FROM cases WHERE guild_id = ? AND number = ? AND action = 'note'").run(i.guildId, number);
    return i.reply(ephemeral(changes ? `✅ Deleted note #${number}.` : `Case #${number} isn't a note.`));
  }
  const user = i.options.getUser('user', true);
  const number = await mod.recordCase(i.guild, { action: 'note', user, moderator: i.user, reason: i.options.getString('text', true) });
  return i.reply(ephemeral(`📝 Saved note #${number} on ${user}. See it with \`/history\`.`));
}

async function reasons(i) {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const rows = db.prepare('SELECT text FROM reasons WHERE guild_id = ? ORDER BY text').all(i.guildId);
    return i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [new EmbedBuilder().setColor(BRAND).setTitle('📋 Saved reasons')
        .setDescription(rows.map((r) => `• ${escapeMarkdown(r.text)}`).join('\n') || 'None yet. Add one with `/reasons add`.')],
    });
  }
  const text = i.options.getString('reason', true).trim();
  if (sub === 'add') {
    const count = db.prepare('SELECT COUNT(*) AS n FROM reasons WHERE guild_id = ?').get(i.guildId).n;
    if (count >= 100) return i.reply(ephemeral('You can save up to 100 reasons. Remove some first.'));
    db.prepare('INSERT OR IGNORE INTO reasons (guild_id, text) VALUES (?, ?)').run(i.guildId, text);
    return i.reply(ephemeral(`✅ Saved "${text}". It now shows up when you type a reason.`));
  }
  const { changes } = db.prepare('DELETE FROM reasons WHERE guild_id = ? AND text = ?').run(i.guildId, text);
  return i.reply(ephemeral(changes ? `✅ Removed "${text}".` : "That reason isn't saved."));
}

const periodText = (days) => (days ? `last ${days} days` : 'all time');

// Actions per moderator: cases they recorded, tickets they claimed and reports they handled.
function staffActivity(guildId, since) {
  const staff = new Map();
  const add = (id, key, n) => {
    if (!staff.has(id)) staff.set(id, { total: 0 });
    staff.get(id)[key] = (staff.get(id)[key] ?? 0) + n;
    staff.get(id).total += n;
  };
  for (const r of db.prepare("SELECT moderator_id AS id, action, COUNT(*) AS n FROM cases WHERE guild_id = ? AND created_at >= ? AND action != 'note' GROUP BY moderator_id, action").all(guildId, since)) add(r.id, r.action, r.n);
  for (const r of db.prepare('SELECT claimed_by AS id, COUNT(*) AS n FROM tickets WHERE guild_id = ? AND created_at >= ? AND claimed_by IS NOT NULL GROUP BY claimed_by').all(guildId, since)) add(r.id, 'tickets', r.n);
  for (const r of db.prepare('SELECT handled_by AS id, COUNT(*) AS n FROM reports WHERE guild_id = ? AND created_at >= ? AND handled_by IS NOT NULL GROUP BY handled_by').all(guildId, since)) add(r.id, 'reports', r.n);
  return staff;
}

function activityLine(stats) {
  const parts = Object.entries(mod.ACTIONS).filter(([a]) => stats[a]).map(([a, { emoji }]) => `${emoji} ${stats[a]}`);
  if (stats.tickets) parts.push(`🎫 ${stats.tickets}`);
  if (stats.reports) parts.push(`🚩 ${stats.reports}`);
  return parts.join('  ');
}

async function modstats(i) {
  const days = i.options.getInteger('days') ?? 30;
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const staff = staffActivity(i.guildId, since);
  const who = i.options.getUser('moderator');
  const botId = i.client.user.id;

  if (who) {
    const stats = staff.get(who.id);
    const recent = db.prepare("SELECT * FROM cases WHERE guild_id = ? AND moderator_id = ? AND created_at >= ? AND action != 'note' ORDER BY number DESC LIMIT 10")
      .all(i.guildId, who.id, since);
    return i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [new EmbedBuilder().setColor(BRAND)
        .setAuthor({ name: `${who.username} · ${periodText(days)}`, iconURL: who.displayAvatarURL() })
        .setDescription(stats ? `**${stats.total} actions**\n${activityLine(stats)}` : 'No actions in this period.')
        .addFields({ name: 'Latest cases', value: recent.map((c) => `\`#${c.number}\` ${mod.ACTIONS[c.action].emoji} <@${c.user_id}> <t:${unix(c.created_at)}:R>`).join('\n') || '—' })],
    });
  }

  const ranked = [...staff.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 15);
  const lines = ranked.map(([id, stats], n) => `\`${n + 1}.\` ${id === botId ? '🤖 Automatic' : `<@${id}>`} · **${stats.total}** · ${activityLine(stats)}`);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder().setColor(BRAND).setTitle(`📈 Staff activity · ${periodText(days)}`)
      .setDescription(lines.join('\n') || 'No staff actions in this period.')
      .setFooter({ text: 'Cases, claimed tickets (🎫) and handled reports (🚩). Notes are not counted.' })],
  });
}

module.exports = [
  {
    data: command('modstats', 'How active each moderator has been', PermissionFlagsBits.ManageGuild)
      .addIntegerOption((o) => o.setName('days').setDescription('Period (default: 30 days)')
        .addChoices({ name: 'Last 7 days', value: 7 }, { name: 'Last 30 days', value: 30 }, { name: 'Last 90 days', value: 90 }, { name: 'All time', value: 0 }))
      .addUserOption((o) => o.setName('moderator').setDescription('Details for one moderator')),
    execute: modstats,
  },

  {
    data: command('history', "Every case and note for a member", PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('User or user ID').setRequired(true)),
    execute: history,
  },

  {
    data: command('case', 'Look up or edit a case', PermissionFlagsBits.ModerateMembers)
      .addSubcommand((s) => s.setName('view').setDescription('Show one case')
        .addIntegerOption((o) => o.setName('number').setDescription('Case number').setMinValue(1).setRequired(true)))
      .addSubcommand((s) => s.setName('reason').setDescription("Change a case's reason")
        .addIntegerOption((o) => o.setName('number').setDescription('Case number').setMinValue(1).setRequired(true))
        .addStringOption((o) => mod.reasonOption(o).setRequired(true))),
    execute: caseCommand,
  },

  {
    data: command('note', 'Private staff notes on a member', PermissionFlagsBits.ModerateMembers)
      .addSubcommand((s) => s.setName('add').setDescription('Add a note only staff can see')
        .addUserOption((o) => o.setName('user').setDescription('User or user ID').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('The note').setMaxLength(1000).setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a note')
        .addIntegerOption((o) => o.setName('case').setDescription('Note number from /history').setMinValue(1).setRequired(true))),
    execute: note,
  },

  {
    data: command('reasons', 'Saved reasons that autocomplete in moderation commands', PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Save a reason')
        .addStringOption((o) => o.setName('reason').setDescription('e.g. Spam, NSFW, Harassment').setMaxLength(100).setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a saved reason')
        .addStringOption((o) => o.setName('reason').setDescription('Reason to remove').setAutocomplete(true).setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show saved reasons')),
    execute: reasons,
  },
];
