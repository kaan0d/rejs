const { SlashCommandBuilder, EmbedBuilder, ApplicationCommandOptionType, MessageFlags } = require('discord.js');
const { BRAND } = require('../util');

module.exports = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is responsive'),
    async execute(i) {
      await i.reply({ content: `🏓 Pong! ${i.client.ws.ping} ms`, flags: MessageFlags.Ephemeral });
    },
  },

  {
    data: new SlashCommandBuilder().setName('help').setDescription('What this bot can do'),
    async execute(i) {
      const everyone = [];
      const staff = [];
      for (const { data, owner } of i.client.commands.values()) {
        if (owner && !i.client.isOwner(i.user.id)) continue;
        const json = data.toJSON();
        const perms = json.default_member_permissions;
        // Only list commands this member can actually run.
        if (perms && !i.memberPermissions?.has(BigInt(perms))) continue;

        // One line per command keeps the list under Discord's embed size limit.
        const id = i.client.application.commands.cache.find((c) => c.name === json.name)?.id;
        const subs = json.options?.filter((o) => o.type === ApplicationCommandOptionType.Subcommand).map((s) => s.name) ?? [];
        const name = id ? `</${json.name}${subs.length ? ` ${subs[0]}` : ''}:${id}>` : `\`/${json.name}\``;
        const more = subs.length > 1 ? ` (${subs.join(', ')})` : '';
        (perms ? staff : everyone).push(`${name} · ${json.description}${more}`);
      }

      // Everyone and staff get their own embed, so each stays under the 4096-character limit.
      // ponytail: a message holds 6000 characters in total; past ~60 commands switch to a category menu.
      const embeds = [new EmbedBuilder().setColor(BRAND).setTitle(`👋 ${i.client.user.username}`).setDescription(everyone.join('\n'))];
      if (staff.length) embeds.push(new EmbedBuilder().setColor(BRAND).setTitle('🛠️ Staff').setDescription(staff.join('\n')));
      await i.reply({ embeds, flags: MessageFlags.Ephemeral });
    },
  },
];
