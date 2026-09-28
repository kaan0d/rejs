const { Events, PermissionFlagsBits } = require('discord.js');
const { getFeature } = require('./db');
const mod = require('./moderation');

const DEFAULTS = { enabled: false, flood: 6, duplicates: 3, caps: true, emojis: 10, links: 'off', allowedDomains: [] };
const FLOOD_WINDOW_MS = 5_000;
const REPEAT_WINDOW_MS = 30_000;
// One warning per burst; the rest of the burst is only deleted.
const WARN_COOLDOWN_MS = 15_000;

// `${guildId}:${userId}` -> recent messages [{ at, text }]
const history = new Map();
const lastWarned = new Map();

const hostsIn = (text) => [...text.matchAll(/https?:\/\/([^\s/?#<>]+)/gi)].map((m) => m[1].toLowerCase().replace(/^www\./, ''));
const allowed = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

// Returns why a message is spam, or null. Keeps the per-user history it needs.
function check(key, text, cfg, now = Date.now()) {
  const list = (history.get(key) ?? []).filter((m) => now - m.at < REPEAT_WINDOW_MS);
  const normalized = text.trim().toLowerCase();
  list.push({ at: now, text: normalized });
  history.set(key, list);

  if (cfg.links !== 'off') {
    const bad = hostsIn(text).filter((h) => cfg.links === 'block' || !allowed(h, cfg.allowedDomains));
    if (bad.length) return cfg.links === 'block' ? 'Links are not allowed here' : `Links to ${bad[0]} are not allowed here`;
  }
  if (cfg.caps) {
    const letters = text.match(/\p{L}/gu) ?? [];
    const upper = letters.filter((c) => c !== c.toLowerCase()).length;
    if (letters.length >= 10 && upper / letters.length >= 0.7) return 'Too many capital letters';
  }
  if (cfg.emojis) {
    const count = (text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0) + (text.match(/<a?:\w+:\d+>/g)?.length ?? 0);
    if (count > cfg.emojis) return 'Too many emojis';
  }
  if (cfg.duplicates && normalized && list.filter((m) => m.text === normalized).length >= cfg.duplicates) return 'Repeating the same message';
  if (cfg.flood && list.filter((m) => now - m.at < FLOOD_WINDOW_MS).length >= cfg.flood) return 'Sending messages too fast';
  return null;
}

async function onMessage(message) {
  if (!message.inGuild() || message.author.bot) return;
  const cfg = getFeature(message.guildId, 'antispam', DEFAULTS);
  if (!cfg.enabled || message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const key = `${message.guildId}:${message.author.id}`;
  const reason = check(key, message.content, cfg);
  if (!reason) return;
  await message.delete().catch(() => {});

  const now = Date.now();
  if (now - (lastWarned.get(key) ?? 0) < WARN_COOLDOWN_MS) return;
  lastWarned.set(key, now);

  const notice = await message.channel.send({ content: `⚠️ ${message.author}, ${reason.toLowerCase()}.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 6_000);

  const bot = message.guild.members.me;
  await mod.recordCase(message.guild, { action: 'warn', user: message.author, moderator: bot.user, reason: `Automatic: ${reason}` });
  await mod.notify(message.author, `⚠️ You were warned in **${message.guild.name}**: ${reason}.`);
  if (message.member) await mod.escalate(message.member, mod.activeWarnings(message.guildId, message.author.id));
}

function register(client) {
  // Spam checks read message text, which only arrives with the Message Content intent.
  if (!client.hasMessageContent) return;
  client.on(Events.MessageCreate, (m) => onMessage(m).catch((e) => console.error('Anti-spam:', e)));
  // Forget quiet users so memory doesn't grow with every member who ever talked.
  setInterval(() => {
    const cutoff = Date.now() - REPEAT_WINDOW_MS;
    for (const [key, list] of history) if (list.at(-1).at < cutoff) history.delete(key);
    for (const [key, at] of lastWarned) if (at < cutoff) lastWarned.delete(key);
  }, 10 * 60_000).unref();
}

module.exports = { DEFAULTS, register, check };
