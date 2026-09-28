const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, InteractionContextType, MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const { BRAND, ephemeral } = require('../util');
const snapshots = require('../snapshots');
const mod = require('../moderation');

const unix = (ms) => Math.floor(ms / 1000);
const listNames = (items, name) => items.slice(0, 20).map(name).join(', ') + (items.length > 20 ? ` …and ${items.length - 20} more` : '');

async function snapshotCommand(i) {
  if (i.options.getSubcommand() === 'take') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const s = await snapshots.take(i.guild);
    return i.editReply(`📸 Snapshot #${s.id} saved: ${s.roles} roles and ${s.channels} channels. The last ${snapshots.KEEP} are kept.`);
  }
  const rows = snapshots.list(i.guildId);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder().setColor(BRAND).setTitle('📸 Server snapshots')
      .setDescription(rows.map((s) => `\`#${s.id}\` <t:${unix(s.taken_at)}:f> (<t:${unix(s.taken_at)}:R>) · ${s.data.roles.length} roles, ${s.data.channels.length} channels`).join('\n')
        || 'None yet. The bot takes one every day; `/snapshot take` takes one now.')],
  });
}

async function restoreCommand(i) {
  const id = i.options.getInteger('snapshot');
  const snapshot = id ? snapshots.get(i.guildId, id) : snapshots.list(i.guildId)[0];
  if (!snapshot) return i.reply(ephemeral(id ? `There is no snapshot #${id}.` : 'There are no snapshots yet. The bot takes one every day.'));

  const { roles, channels } = snapshots.missing(i.guild, snapshot);
  if (!roles.length && !channels.length) return i.reply(ephemeral(`Nothing is missing compared to snapshot #${snapshot.id}.`));

  const lines = [`Snapshot #${snapshot.id} from <t:${unix(snapshot.taken_at)}:R> has things this server no longer has.`];
  if (roles.length) lines.push(`**${roles.length} roles:** ${listNames(roles, (r) => r.name)}`);
  if (channels.length) lines.push(`**${channels.length} channels:** ${listNames(channels, (c) => `#${c.name}`)}`);
  lines.push('', 'They will be recreated with their settings and permissions, and members get the recreated roles back. Messages in deleted channels are gone for good. Changed (not deleted) things are left alone.');

  const response = await i.reply({
    embeds: [new EmbedBuilder().setColor(Colors.Orange).setTitle('🛟 Restore from snapshot?').setDescription(lines.join('\n'))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('restore').setLabel('Restore').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
    flags: MessageFlags.Ephemeral,
  });
  const choice = await response.awaitMessageComponent({ time: 60_000 }).catch(() => null);
  if (choice?.customId !== 'restore') {
    return choice ? choice.update({ content: 'Cancelled.', embeds: [], components: [] }) : i.editReply({ content: 'Timed out.', embeds: [], components: [] });
  }
  await choice.update({ content: '⏳ Restoring…', embeds: [], components: [] });

  const result = await snapshots.restore(i.guild, snapshot, (text) => i.editReply(`⏳ ${text}`).catch(() => {}));
  const summary = `Recreated ${result.roles} roles and ${result.channels} channels, gave ${result.members} roles back to members, moved ${result.moved} channels back into categories.`;
  await mod.modLog(i.guild, { title: '🛟 Restored from snapshot', color: Colors.Green, moderator: i.user, extra: `Snapshot #${snapshot.id}. ${summary}` });
  const failed = result.failed.length ? `\n⚠️ ${result.failed.length} failed:\n${result.failed.slice(0, 10).map((f) => `• ${f}`).join('\n')}` : '';
  await i.editReply(`✅ ${summary}${failed}\n\`/undo\` removes everything this restore created.`).catch(() => {});
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('snapshot')
      .setDescription('Daily copies of your roles and channels, for recovering from a nuke')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('take').setDescription('Save a snapshot now'))
      .addSubcommand((s) => s.setName('list').setDescription('Show saved snapshots')),
    execute: snapshotCommand,
  },

  {
    data: new SlashCommandBuilder()
      .setName('restore')
      .setDescription('Recreate roles and channels that were deleted since a snapshot')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addIntegerOption((o) => o.setName('snapshot').setDescription('Snapshot number from /snapshot list (default: the newest)').setMinValue(1)),
    execute: restoreCommand,
  },
];
