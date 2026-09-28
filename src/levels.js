const { EmbedBuilder, Colors } = require('discord.js');
const { db, getSettings } = require('./db');

const MIN_LEVEL = 1;
const MAX_LEVEL = 500;
const THANK_COOLDOWN_MS = 60_000;
// Whole words only, so "party" or "pretty" never count as "ty".
const THANK_WORDS = /\b(ty|tysm|thx|thanks|thank you|thank u)\b/i;

const requiredXp = (level) => Math.min(1000, Math.max(10, Math.round(level * 2.4)));

function applyXp({ level, xp }, amount) {
  xp += amount;
  while (level < MAX_LEVEL && xp >= requiredXp(level)) {
    xp -= requiredXp(level);
    level++;
  }
  return level >= MAX_LEVEL ? { level: MAX_LEVEL, xp: 0 } : { level, xp };
}

const clampLevel = (level) => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level));

function progressBar(xp, total, size = 12) {
  const filled = Math.round((xp / total) * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

const getProgress = (guildId, userId) =>
  db.prepare('SELECT level, xp, thanks FROM levels WHERE guild_id = ? AND user_id = ?').get(guildId, userId)
  ?? { level: MIN_LEVEL, xp: 0, thanks: 0 };

const saveProgress = (guildId, userId, { level, xp, thanks }) =>
  db.prepare(`
    INSERT INTO levels (guild_id, user_id, level, xp, thanks) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET level = excluded.level, xp = excluded.xp, thanks = excluded.thanks
  `).run(guildId, userId, level, xp, thanks);

const rankOf = (guildId, { level, xp }) =>
  db.prepare('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND (level > ? OR (level = ? AND xp > ?))')
    .get(guildId, level, level, xp).n + 1;

function grantXp(guildId, userId, amount, thanks = 0) {
  const before = getProgress(guildId, userId);
  const after = { ...applyXp(before, amount), thanks: before.thanks + thanks };
  saveProgress(guildId, userId, after);
  return { before, after };
}

function setLevel(guildId, userId, level) {
  const before = getProgress(guildId, userId);
  const after = { level: clampLevel(level), xp: 0, thanks: before.thanks };
  saveProgress(guildId, userId, after);
  return { before, after };
}

// Gives any reward roles between the old and new level, then posts the level-up.
async function announceLevelUp(guild, user, { before, after }, fallbackChannel) {
  if (after.level <= before.level) return;

  const rewards = db.prepare('SELECT role_id FROM level_roles WHERE guild_id = ? AND level > ? AND level <= ?')
    .all(guild.id, before.level, after.level);
  const gained = [];
  if (rewards.length) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    for (const { role_id } of rewards) {
      if (await member?.roles.add(role_id).then(() => true, () => false)) gained.push(`<@&${role_id}>`);
    }
  }

  const next = after.level === MAX_LEVEL ? 'Max level reached!' : `Next level in **${requiredXp(after.level)} XP**.`;
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('🎉 Level up!')
    .setThumbnail(user.displayAvatarURL())
    .setDescription(`${user} reached **level ${after.level}**.\n${next}${gained.length ? `\nNew role: ${gained.join(', ')}` : ''}`);

  const { levelup_channel_id } = getSettings(guild.id);
  const channel = (levelup_channel_id && guild.channels.cache.get(levelup_channel_id)) || fallbackChannel;
  await channel?.send({ embeds: [embed] }).catch(() => {});
}

const cooldowns = new Map();

// Shared by the thank words in chat and the /thank command. Callers announce the level-up.
function thank(guild, giver, target) {
  if (target.bot) return { error: "Bots don't collect XP." };
  if (target.id === giver.id) return { error: "You can't thank yourself." };

  const key = `${guild.id}:${giver.id}`;
  const readyAt = cooldowns.get(key) ?? 0;
  if (readyAt > Date.now()) return { error: `You can thank someone again <t:${Math.ceil(readyAt / 1000)}:R>.` };
  cooldowns.set(key, Date.now() + THANK_COOLDOWN_MS);

  return grantXp(guild.id, target.id, 1, 1);
}

async function onMessage(message) {
  if (!message.inGuild() || message.author.bot || !THANK_WORDS.test(message.content)) return;
  const target = [message.mentions.repliedUser, ...message.mentions.users.values()]
    .find((u) => u && u.id !== message.author.id);
  if (!target) return;
  const change = thank(message.guild, message.author, target);
  if (change.error) return;
  await message.react('✨').catch(() => {});
  await announceLevelUp(message.guild, target, change, message.channel);
}

module.exports = {
  MIN_LEVEL, MAX_LEVEL, THANK_WORDS,
  requiredXp, applyXp, progressBar, getProgress, rankOf,
  grantXp, setLevel, announceLevelUp, thank, onMessage,
};
