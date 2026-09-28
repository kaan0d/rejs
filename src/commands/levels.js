const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors,
  InteractionContextType,
} = require('discord.js');
const { db } = require('../db');
const levels = require('../levels');

const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const { ephemeral } = require('../util');

const xpLine = ({ level, xp }) => level === levels.MAX_LEVEL ? 'max level' : `${xp}/${levels.requiredXp(level)} XP`;

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription("Show your level and progress, or someone else's")
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Whose rank to show')),
    async execute(i) {
      const user = i.options.getUser('user') ?? i.user;
      const p = levels.getProgress(i.guildId, user.id);
      const embed = new EmbedBuilder()
        .setColor(Colors.Blurple)
        .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
        .addFields(
          { name: 'Level', value: `${p.level}`, inline: true },
          { name: 'Rank', value: `#${levels.rankOf(i.guildId, p)}`, inline: true },
          { name: 'Thanked', value: `${p.thanks} times`, inline: true },
        );
      if (p.level === levels.MAX_LEVEL) {
        embed.setDescription('🏆 Max level reached!');
      } else {
        const needed = levels.requiredXp(p.level);
        embed
          .setDescription(`${levels.progressBar(p.xp, needed)}  **${p.xp}/${needed} XP**`)
          .setFooter({ text: `${needed - p.xp} XP to level ${p.level + 1}` });
      }
      await i.reply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Top members by level')
      .setContexts(InteractionContextType.Guild),
    async execute(i) {
      const total = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ?').get(i.guildId).n;
      if (!total) return i.reply(ephemeral('Nobody has XP yet. Thank someone to get it started!'));

      const pages = Math.ceil(total / PAGE_SIZE);
      const myRank = levels.rankOf(i.guildId, levels.getProgress(i.guildId, i.user.id));
      let page = 0;

      const render = () => {
        const rows = db.prepare('SELECT user_id, level, xp FROM levels WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT ? OFFSET ?')
          .all(i.guildId, PAGE_SIZE, page * PAGE_SIZE);
        const lines = rows.map((row, n) => {
          const pos = page * PAGE_SIZE + n;
          const you = row.user_id === i.user.id ? '  ← you' : '';
          return `${MEDALS[pos] ?? `\`${pos + 1}.\``} <@${row.user_id}> · level **${row.level}** · ${xpLine(row)}${you}`;
        });
        const embed = new EmbedBuilder()
          .setColor(Colors.Gold)
          .setTitle(`🏆 ${i.guild.name} leaderboard`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `Page ${page + 1}/${pages} · Your rank: #${myRank}` });
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId('next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
        );
        return { embeds: [embed], components: pages > 1 ? [buttons] : [] };
      };

      const response = await i.reply(render());
      if (pages === 1) return;
      const collector = response.createMessageComponentCollector({ time: 120_000 });
      collector.on('collect', async (button) => {
        if (button.user.id !== i.user.id) return button.reply(ephemeral('Run /leaderboard to browse your own copy.'));
        page += button.customId === 'next' ? 1 : -1;
        await button.update(render());
      });
      collector.on('end', () => i.editReply({ components: [] }).catch(() => {}));
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('thank')
      .setDescription('Thank someone and give them 1 XP')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('user').setDescription('Who helped you').setRequired(true)),
    async execute(i) {
      const target = i.options.getUser('user', true);
      const change = levels.thank(i.guild, i.user, target);
      if (change.error) return i.reply(ephemeral(change.error));
      await i.reply(`✨ ${i.user} thanked ${target}! (${xpLine(change.after)})`);
      await levels.announceLevelUp(i.guild, target, change, i.channel);
    },
  },
];
