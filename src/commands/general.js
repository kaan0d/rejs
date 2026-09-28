const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ApplicationCommandOptionType, MessageFlags,
} = require('discord.js');
const { BRAND } = require('../util');

// Groups the commands this member can use by category, one line per command.
function commandsFor(i) {
  const groups = new Map();
  for (const { data, owner, category } of i.client.commands.values()) {
    if (owner && !i.client.isOwner(i.user.id)) continue;
    const json = data.toJSON();
    if (json.type !== 1) continue; // right-click menu commands are explained under General
    const perms = json.default_member_permissions;
    if (perms && !i.memberPermissions?.has(BigInt(perms))) continue;

    const id = i.client.application.commands.cache.find((c) => c.name === json.name)?.id;
    const subs = json.options?.filter((o) => o.type === ApplicationCommandOptionType.Subcommand).map((s) => s.name) ?? [];
    const name = id ? `</${json.name}${subs.length ? ` ${subs[0]}` : ''}:${id}>` : `\`/${json.name}\``;
    const more = subs.length > 1 ? ` (${subs.join(', ')})` : '';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(`${name} · ${json.description}${more}`);
  }
  return groups;
}

module.exports = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is responsive'),
    async execute(i) {
      await i.reply({ content: `Pong! ${i.client.ws.ping} ms`, flags: MessageFlags.Ephemeral });
    },
  },

  {
    data: new SlashCommandBuilder().setName('help').setDescription('What this bot can do'),
    async execute(i) {
      const groups = commandsFor(i);
      const names = [...groups.keys()];
      // One category per page keeps every page far below Discord's size limits.
      const render = (category) => {
        const lines = [...groups.get(category)];
        if (category === names[0]) lines.push('', 'Right-click a message → **Apps** → **Report message** to report it to staff.');
        return {
          embeds: [new EmbedBuilder().setColor(BRAND).setTitle(category).setDescription(lines.join('\n'))
            .setFooter({ text: names.length > 1 ? 'Pick another category below' : i.client.user.username })],
          components: names.length > 1 ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId('help-category')
            .addOptions(names.map((n) => ({ label: `${n} (${groups.get(n).length})`, value: n, default: n === category }))))] : [],
          flags: MessageFlags.Ephemeral,
        };
      };

      const response = await i.reply(render(names[0]));
      if (names.length < 2) return;
      const collector = response.createMessageComponentCollector({ time: 300_000 });
      collector.on('collect', (select) => select.update(render(select.values[0])));
      collector.on('end', () => i.editReply({ components: [] }).catch(() => {}));
    },
  },
];
