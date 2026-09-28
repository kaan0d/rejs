const { randomInt } = require('node:crypto');
const { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');
const { db } = require('./db');
const { BRAND, ephemeral } = require('./util');
const { formatDuration } = require('./monitor');

const unix = (ms) => Math.floor(ms / 1000);
const getGiveaway = (id) => db.prepare('SELECT * FROM giveaways WHERE id = ?').get(Number(id));
const entryCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?').get(id).n;

// Returns why this member can't enter, or null.
function ineligible(member, g) {
  if (g.required_role && !member.roles.cache.has(g.required_role)) return `You need <@&${g.required_role}> to enter.`;
  if (g.min_age_ms && Date.now() - member.user.createdTimestamp < g.min_age_ms) return `Your account must be at least ${formatDuration(g.min_age_ms)} old to enter.`;
  return null;
}

function giveawayMessage(g) {
  const winners = JSON.parse(g.winner_ids);
  const lines = g.ended
    ? [winners.length ? `**Winner${winners.length === 1 ? '' : 's'}:** ${winners.map((id) => `<@${id}>`).join(', ')}` : 'No valid entries, so nobody won.', `Ended <t:${unix(g.ends_at)}:R>`]
    : ['Click the button to enter.', `**Ends:** <t:${unix(g.ends_at)}:R> (<t:${unix(g.ends_at)}:f>)`, `**Winners:** ${g.winners}`];
  if (g.required_role) lines.push(`**Requires:** <@&${g.required_role}>`);
  if (g.min_age_ms) lines.push(`**Account age:** at least ${formatDuration(g.min_age_ms)}`);
  lines.push(`**Hosted by:** <@${g.host_id}>`);
  return {
    embeds: [new EmbedBuilder()
      .setColor(g.ended ? Colors.Grey : BRAND)
      .setTitle(`${escapeMarkdown(g.prize)}`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Giveaway #${g.id}` })
      .setTimestamp(g.ends_at)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gw-enter:${g.id}`).setLabel(`Enter · ${entryCount(g.id)}`)
        .setStyle(ButtonStyle.Primary).setDisabled(Boolean(g.ended)),
    )],
    allowedMentions: { parse: [] },
  };
}

// Draws winners who are still in the server and still meet the requirements.
async function drawWinners(guild, g, count, exclude = []) {
  const pool = db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(g.id)
    .map((r) => r.user_id).filter((id) => !exclude.includes(id));
  const winners = [];
  while (pool.length && winners.length < count) {
    const [id] = pool.splice(randomInt(pool.length), 1);
    const member = await guild?.members.fetch(id).catch(() => null);
    if (member && !ineligible(member, g)) winners.push(id);
  }
  return winners;
}

async function endGiveaway(client, g, { reroll = 0 } = {}) {
  if (!reroll) {
    const { changes } = db.prepare('UPDATE giveaways SET ended = 1 WHERE id = ? AND ended = 0').run(g.id);
    if (!changes) return null;
  }
  const guild = client.guilds.cache.get(g.guild_id);
  const previous = JSON.parse(g.winner_ids);
  const winners = await drawWinners(guild, g, reroll || g.winners, previous);
  db.prepare('UPDATE giveaways SET winner_ids = ? WHERE id = ?').run(JSON.stringify([...previous, ...winners]), g.id);
  const updated = getGiveaway(g.id);

  const channel = guild?.channels.cache.get(g.channel_id);
  const message = await channel?.messages.fetch(g.message_id).catch(() => null);
  await message?.edit(giveawayMessage(updated)).catch(() => {});
  const text = winners.length
    ? `${reroll ? 'New winner' : 'Congratulations'} ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${escapeMarkdown(g.prize)}**.`
    : `Nobody eligible entered the **${escapeMarkdown(g.prize)}** giveaway.`;
  await (message ? message.reply({ content: text, allowedMentions: { users: winners } }) : channel?.send(text)).catch(() => {});
  return winners;
}

async function checkGiveaways(client) {
  for (const g of db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?').all(Date.now())) {
    await endGiveaway(client, g).catch((e) => console.error(`Giveaway #${g.id}:`, e));
  }
}

const handlers = {
  async 'gw-enter'(i, id) {
    const g = getGiveaway(id);
    if (!g || g.ended) return i.reply(ephemeral('This giveaway has ended.'));
    const reason = ineligible(i.member, g);
    if (reason) return i.reply(ephemeral(reason));
    const { changes } = db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').run(g.id, i.user.id);
    if (!changes) db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)').run(g.id, i.user.id);
    await i.update(giveawayMessage(g));
    await i.followUp(ephemeral(changes ? 'You left the giveaway.' : 'You entered! Click again to leave.'));
  },
};

module.exports = { getGiveaway, giveawayMessage, endGiveaway, checkGiveaways, drawWinners, ineligible, handlers };
