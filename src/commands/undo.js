const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, Colors,
  InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
} = require('discord.js');
const journal = require('../journal');
const community = require('../community');
const giveaways = require('../giveaways');
const mod = require('../moderation');
const { db } = require('../db');
const { BRAND } = require('../util');

const unix = (ms) => Math.floor(ms / 1000);

// Messages that show database state and need re-rendering after an undo.
const refreshers = {
  rolemenu: (guild, id) => {
    const menu = community.getMenu(id);
    return menu && community.refreshMenu(guild, menu);
  },
  suggestion: async (guild, id) => {
    const s = community.getSuggestion(id);
    const message = await guild.channels.cache.get(s?.channel_id)?.messages.fetch(s.message_id).catch(() => null);
    return message?.edit(await community.suggestionMessage(guild.client, s));
  },
  giveaway: async (guild, id) => {
    const g = giveaways.getGiveaway(id);
    const message = await guild.channels.cache.get(g?.channel_id)?.messages.fetch(g.message_id).catch(() => null);
    return message?.edit(giveaways.giveawayMessage(g));
  },
};

// A short, human description of what an entry changed.
function describe(e) {
  const steps = JSON.parse(e.steps).filter((s) => s.type !== 'refresh');
  const rows = db.prepare('SELECT COUNT(*) AS n FROM undo_rows WHERE tx = ?').get(e.id).n;
  const counts = {};
  for (const s of steps) counts[s.type] = (counts[s.type] ?? 0) + 1;
  const names = {
    deleteChannel: 'channels created', deleteRole: 'roles created', deleteMessage: 'messages posted', overwrite: 'permission changes',
    channelField: 'channel settings', verificationLevel: 'verification level', memberRole: 'member role changes', nickname: 'nicknames',
    timeout: 'timeouts', unban: 'bans', ban: 'unbans', threadMember: 'ticket members', deleteAutomod: 'AutoMod rules created',
    restoreAutomod: 'AutoMod rules changed', recreateAutomod: 'AutoMod rules deleted',
  };
  const parts = Object.entries(counts).map(([type, n]) => `${n} ${names[type] ?? type}`);
  if (rows) parts.unshift(`${rows} saved setting${rows === 1 ? '' : 's'} or records`);
  return parts.join(', ') || 'nothing to reverse';
}

const canUndo = (i, e) => !e.permissions || i.memberPermissions.has(new PermissionsBitField(BigInt(e.permissions)));

async function execute(i) {
  const entries = journal.undoable(i.guildId).filter((e) => canUndo(i, e));
  if (!entries.length) return i.reply({ content: 'Nothing to undo from the last 7 days that you have permission for.', flags: MessageFlags.Ephemeral });

  const menu = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('undo-pick')
    .setPlaceholder('Pick an action to undo')
    .addOptions(entries.map((e) => ({
      label: e.label.slice(0, 100),
      value: String(e.id),
      description: `#${e.id} · ${new Date(e.created_at).toISOString().slice(5, 16).replace('T', ' ')} UTC${JSON.parse(e.notes).length ? ' · partly undoable' : ''}`,
    }))));
  const response = await i.reply({
    embeds: [new EmbedBuilder().setColor(BRAND).setTitle('↩️ Undo')
      .setDescription('Pick one of the last 25 staff actions from the past 7 days. You will see what changes before anything happens.')],
    components: [menu],
    flags: MessageFlags.Ephemeral,
  });

  const collector = response.createMessageComponentCollector({ time: 300_000 });
  let picked = null;
  collector.on('collect', async (c) => {
    if (c.customId === 'undo-pick') {
      picked = journal.entry(Number(c.values[0]));
      const notes = JSON.parse(picked.notes);
      const newer = journal.newerThan(i.guildId, picked.id);
      const embed = new EmbedBuilder()
        .setColor(Colors.Orange)
        .setTitle(`↩️ Undo #${picked.id}?`)
        .setDescription(`\`${picked.label}\`\nby <@${picked.user_id}> <t:${unix(picked.created_at)}:R>`)
        .addFields({ name: 'Will reverse', value: describe(picked) });
      if (notes.length) embed.addFields({ name: "Can't be reversed", value: notes.map((n) => `• ${n}`).join('\n') });
      if (newer) embed.addFields({ name: '⚠️ Newer changes', value: `${newer} later action${newer === 1 ? '' : 's'} may have touched the same things. Undoing this can overwrite them.` });
      return c.update({
        embeds: [embed],
        components: [menu, new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('undo-confirm').setLabel('Undo it').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('undo-cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
      });
    }
    collector.stop();
    if (c.customId === 'undo-cancel' || !picked) return c.update({ content: 'Cancelled. Nothing changed.', embeds: [], components: [] });

    await c.update({ content: `⏳ Undoing #${picked.id}…`, embeds: [], components: [] });
    const result = await journal.undo(i.guild, picked.id, i.user.id, refreshers);
    if (!result) return c.editReply({ content: 'That action was already undone.' });
    const lines = [`✅ Undid #${picked.id} \`${picked.label}\`: ${result.rows} records and ${result.steps} Discord changes reversed.`];
    if (result.failed.length) lines.push(`⚠️ ${result.failed.length} couldn't be reversed:`, ...result.failed.slice(0, 10).map((f) => `• ${f}`));
    if (result.notes.length) lines.push(`Not reversible: ${result.notes.join('; ')}`);
    await c.editReply({ content: lines.join('\n') });
    await mod.modLog(i.guild, {
      title: '↩️ Action undone',
      color: Colors.Grey,
      moderator: i.user,
      extra: `**Undid:** #${picked.id} \`${picked.label}\` by <@${picked.user_id}>${result.failed.length ? `\n**Could not reverse:** ${result.failed.length} changes` : ''}`,
    });
  });
  collector.on('end', (_, why) => {
    if (why === 'time') i.editReply({ components: [] }).catch(() => {});
  });
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('undo')
      .setDescription('Reverse a staff action from the last 7 days')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    // Undoing is not itself recorded, so it can't be undone in turn.
    noJournal: true,
    execute,
  },
];
