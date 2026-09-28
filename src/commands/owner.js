const fs = require('node:fs');
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, getSettings } = require('../db');
const { BRAND } = require('../util');
const { formatDuration } = require('../monitor');
const updater = require('../updater');
const ops = require('../ops');
const backup = require('../backup');

// Only the bot owner may run these. They are also hidden from everyone except administrators,
// and registered only in DEV_GUILD_ID when it is set.
const command = (name, description) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const reply = (i, content) => (i.deferred ? i.editReply(content) : i.reply({ content, flags: MessageFlags.Ephemeral }));

module.exports = [
  {
    owner: true,
    data: command('restart', 'Restart the bot (owner only)'),
    async execute(i) {
      await reply(i, '🔄 Restarting…');
      updater.restart();
    },
  },

  {
    owner: true,
    data: command('update', 'Pull the latest code from GitHub and restart (owner only)'),
    async execute(i) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const next = await updater.checkForUpdate();
        if (!next) return reply(i, `✅ Already up to date. Auto-restart on push is **${updater.autoRestart() ? 'on' : 'off'}**.`);
        const commit = await updater.update();
        await reply(i, `🔄 Updated to \`${commit}\`. Restarting…`);
        updater.restart();
      } catch (e) {
        await reply(i, `❌ Update failed: ${e.message}`);
      }
    },
  },

  {
    owner: true,
    data: command('stats', 'Bot statistics (owner only)'),
    async execute(i) {
      const guilds = i.client.guilds.cache;
      const members = guilds.reduce((sum, g) => sum + g.memberCount, 0);
      const dbSize = fs.statSync(process.env.DB_PATH ?? 'rejs.db', { throwIfNoEntry: false })?.size ?? 0;
      const top = ops.topCommands(10).map((c) => `\`/${c.name}\` ${c.count}`).join(' · ') || 'none yet';
      const departed = db.prepare('SELECT COUNT(*) AS n FROM departed_guilds').get().n;
      await i.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder()
          .setColor(BRAND)
          .setTitle('📊 Bot stats')
          .addFields(
            { name: 'Servers', value: `${guilds.size}`, inline: true },
            { name: 'Members', value: `${members.toLocaleString('en')}`, inline: true },
            { name: 'Ping', value: `${i.client.ws.ping} ms`, inline: true },
            { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
            { name: 'Memory', value: `${Math.round(process.memoryUsage().rss / 1048576)} MB`, inline: true },
            { name: 'Database', value: `${(dbSize / 1048576).toFixed(1)} MB`, inline: true },
            { name: 'Waiting for deletion', value: `${departed} servers`, inline: true },
            { name: 'Version', value: `\`${await updater.currentCommit()}\``, inline: true },
            { name: 'Last backup', value: backup.list().at(-1)?.name ?? 'none yet', inline: true },
            { name: 'Node', value: process.version, inline: true },
            { name: 'Most used commands', value: top },
          )],
      });
    },
  },

  {
    owner: true,
    data: command('blacklist', 'Keep the bot out of a server (owner only)')
      .addSubcommand((s) => s.setName('add').setDescription('Leave a server and refuse to rejoin')
        .addStringOption((o) => o.setName('server_id').setDescription('Server ID').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
      .addSubcommand((s) => s.setName('remove').setDescription('Allow a server again')
        .addStringOption((o) => o.setName('server_id').setDescription('Server ID').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show blacklisted servers')),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const rows = db.prepare('SELECT * FROM blacklist ORDER BY added_at DESC LIMIT 50').all();
        return reply(i, rows.map((r) => `\`${r.guild_id}\` <t:${Math.floor(r.added_at / 1000)}:d>${r.reason ? ` · ${r.reason}` : ''}`).join('\n') || 'Nobody is blacklisted.');
      }
      const id = i.options.getString('server_id', true).trim();
      if (!/^\d{17,20}$/.test(id)) return reply(i, "That isn't a server ID.");
      if (sub === 'remove') return reply(i, ops.unblacklist(id) ? `✅ \`${id}\` can add the bot again.` : `\`${id}\` wasn't blacklisted.`);
      if (id === i.guildId) return reply(i, "You can't blacklist the server you're in.");
      const name = await ops.blacklist(i.client, id, i.options.getString('reason'));
      return reply(i, `⛔ Blacklisted \`${id}\`${name ? ` and left **${name}**` : ''}. Its data is deleted in 30 days.`);
    },
  },

  {
    owner: true,
    data: command('announce', "Post an update to every server's mod log (owner only)")
      .addStringOption((o) => o.setName('message').setDescription('Text. Write \\n for a new line').setMaxLength(2000).setRequired(true)),
    async execute(i) {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const embed = new EmbedBuilder()
        .setColor(BRAND)
        .setAuthor({ name: `📢 ${i.client.user.username} update`, iconURL: i.client.user.displayAvatarURL() })
        .setDescription(i.options.getString('message', true).replaceAll('\\n', '\n'))
        .setTimestamp();
      let sent = 0;
      // Only servers with a mod log hear about it; posting in public channels would feel like spam.
      for (const guild of i.client.guilds.cache.values()) {
        const channel = guild.channels.cache.get(getSettings(guild.id).modlog_channel_id);
        if (await channel?.send({ embeds: [embed] }).then(() => true, () => false)) sent++;
      }
      await reply(i, `📢 Sent to ${sent} of ${i.client.guilds.cache.size} servers (the rest have no mod log).`);
    },
  },

  {
    owner: true,
    data: command('backup', 'Back up the database now (owner only)'),
    async execute(i) {
      const result = backup.backup(new Date(), { force: true });
      if (!result) return reply(i, 'Backups are off while the database lives in memory.');
      const size = (result.size / 1048576).toFixed(1);
      return reply(i, `💾 Saved \`${result.file}\` (${size} MB). ${backup.list().length} backups are kept in \`${backup.dir()}\`.`);
    },
  },
];
