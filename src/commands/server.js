const { SlashCommandBuilder, EmbedBuilder, Colors, InteractionContextType, escapeMarkdown } = require('discord.js');
const { db, getSettings } = require('../db');
const monitor = require('../monitor');

const { BRAND, ephemeral } = require('../util');
const NOT_SET_UP = 'No game server is set up here yet. An admin can run `/config monitor`.';
const unix = (ms) => Math.floor(ms / 1000);
// FiveM hostnames carry color codes like ^1.
const cleanHostname = (name) => escapeMarkdown(String(name ?? 'Game server').replace(/\^\d/g, ''));

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('server')
      .setDescription('Live status of the game server')
      .setContexts(InteractionContextType.Guild),
    async execute(i) {
      const { server_url } = getSettings(i.guildId);
      if (!server_url) return i.reply(ephemeral(NOT_SET_UP));
      await i.deferReply();
      try {
        const { players, info } = await monitor.fetchServer(server_url);
        const avgPing = players.length ? Math.round(players.reduce((sum, p) => sum + (p.ping ?? 0), 0) / players.length) : 0;
        await i.editReply({
          embeds: [new EmbedBuilder()
            .setColor(Colors.Green)
            .setTitle(`🟢 ${cleanHostname(info.hostname)}`)
            .addFields(
              { name: 'Players', value: `${info.clients}/${info.sv_maxclients}`, inline: true },
              { name: 'Average ping', value: `${avgPing} ms`, inline: true },
              { name: 'Map', value: `${info.mapname || '—'}`, inline: true },
            )
            .setFooter({ text: 'Use /players to see who is online' })
            .setTimestamp()],
        });
      } catch {
        await i.editReply({
          embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle('🔴 Server is offline').setDescription("I couldn't reach it just now.")],
        });
      }
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('players')
      .setDescription('Who is on the game server, or who left recently')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((o) => o.setName('show').setDescription('Which list (default: online)')
        .addChoices({ name: 'Online now', value: 'online' }, { name: 'Recently left', value: 'recent' })),
    async execute(i) {
      if (!getSettings(i.guildId).server_url) return i.reply(ephemeral(NOT_SET_UP));
      const now = Date.now();
      const discord = (row) => (row.discord_id ? ` · <@${row.discord_id}>` : '');

      let title, rows, line;
      if (i.options.getString('show') === 'recent') {
        title = '🕓 Recently left';
        rows = db.prepare('SELECT * FROM sessions WHERE guild_id = ? AND left_at IS NOT NULL ORDER BY left_at DESC LIMIT 25').all(i.guildId);
        line = (row) => `${escapeMarkdown(row.name)}${discord(row)} · left <t:${unix(row.left_at)}:R> · played ${monitor.formatDuration(row.left_at - row.joined_at)}`;
      } else {
        rows = monitor.openSessions(i.guildId);
        title = `🎮 ${rows.length} online`;
        line = (row) => `${escapeMarkdown(row.name)}${discord(row)} · ${monitor.formatDuration(now - row.joined_at)}`;
      }

      await i.reply({
        embeds: [new EmbedBuilder()
          .setColor(BRAND)
          .setTitle(title)
          .setDescription(rows.length ? monitor.listLines(rows.map(line)) : 'Nobody here.')],
        allowedMentions: { parse: [] },
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('playtime')
      .setDescription('Who has played the most on the game server')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((o) => o.setName('player').setDescription('Search by in-game name').setMaxLength(64)),
    async execute(i) {
      if (!getSettings(i.guildId).server_url) return i.reply(ephemeral(NOT_SET_UP));
      const search = i.options.getString('player');
      const rows = db.prepare(`
        SELECT MAX(name) AS name, SUM(COALESCE(left_at, :now) - joined_at) AS total, COUNT(*) AS sessions
        FROM sessions WHERE guild_id = :guild AND name LIKE :search
        GROUP BY player_key ORDER BY total DESC LIMIT 10
      `).all({ now: Date.now(), guild: i.guildId, search: `%${search ?? ''}%` });

      const lines = rows.map((row, n) =>
        `\`${n + 1}.\` **${escapeMarkdown(row.name)}** · ${monitor.formatDuration(row.total)} over ${row.sessions} session${row.sessions === 1 ? '' : 's'}`);
      await i.reply({
        embeds: [new EmbedBuilder()
          .setColor(BRAND)
          .setTitle(search ? `⏱️ Playtime matching "${escapeMarkdown(search)}"` : '⏱️ Top playtime')
          .setDescription(lines.join('\n') || 'No sessions recorded yet.')],
      });
    },
  },
];
