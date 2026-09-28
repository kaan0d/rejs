const { SlashCommandBuilder, EmbedBuilder, Colors, ApplicationCommandOptionType, MessageFlags } = require('discord.js');

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
      for (const { data } of i.client.commands.values()) {
        const json = data.toJSON();
        const perms = json.default_member_permissions;
        // Only list commands this member can actually run.
        if (perms && !i.memberPermissions?.has(BigInt(perms))) continue;

        const id = i.client.application.commands.cache.find((c) => c.name === json.name)?.id;
        const mention = (name) => (id ? `</${name}:${id}>` : `\`/${name}\``);
        const subs = json.options?.filter((o) => o.type === ApplicationCommandOptionType.Subcommand) ?? [];
        const lines = subs.length
          ? subs.map((s) => `${mention(`${json.name} ${s.name}`)} · ${s.description}`)
          : [`${mention(json.name)} · ${json.description}`];
        (perms ? staff : everyone).push(...lines);
      }

      const description = [
        '**Commands**', ...everyone,
        ...(staff.length ? ['', '**Staff**', ...staff] : []),
      ].join('\n');
      await i.reply({
        embeds: [new EmbedBuilder().setColor(Colors.Blurple).setTitle(`👋 ${i.client.user.username}`).setDescription(description)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
