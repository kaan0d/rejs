const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const updater = require('../updater');

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
];
