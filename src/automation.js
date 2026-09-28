const { Events, ChannelType } = require('discord.js');
const { db, getFeature } = require('./db');

const RESPONDER_COOLDOWN_MS = 10_000;
const STICKY_DELAY_MS = 5_000;

// ---- Auto-responders ------------------------------------------------------------------------

const responderCooldown = new Map();

function matchResponder(guildId, channelId, text) {
  const lower = text.toLowerCase();
  return db.prepare('SELECT * FROM responders WHERE guild_id = ? ORDER BY id').all(guildId).find((r) => {
    const channels = JSON.parse(r.channels);
    return (!channels.length || channels.includes(channelId)) && lower.includes(r.trigger.toLowerCase());
  }) ?? null;
}

async function respond(message) {
  const responder = matchResponder(message.guildId, message.channelId, message.content);
  if (!responder) return;
  // Stops a busy channel from getting the same answer over and over.
  const key = `${responder.id}:${message.channelId}`;
  if (Date.now() - (responderCooldown.get(key) ?? 0) < RESPONDER_COOLDOWN_MS) return;
  responderCooldown.set(key, Date.now());
  await message.reply({ content: responder.response, allowedMentions: { repliedUser: false, parse: [] } }).catch(() => {});
}

// ---- Sticky messages ------------------------------------------------------------------------

const stickyTimers = new Map();

async function repostSticky(channel) {
  const sticky = db.prepare('SELECT * FROM stickies WHERE channel_id = ?').get(channel.id);
  if (!sticky) return;
  if (sticky.message_id) await channel.messages.delete(sticky.message_id).catch(() => {});
  const message = await channel.send({ content: `📌 ${sticky.content}`, allowedMentions: { parse: [] } }).catch(() => null);
  if (message) db.prepare('UPDATE stickies SET message_id = ? WHERE channel_id = ?').run(message.id, channel.id);
}

// Waits for the channel to settle, so a burst of messages causes one repost, not many.
function scheduleSticky(channel) {
  if (!db.prepare('SELECT 1 FROM stickies WHERE channel_id = ?').get(channel.id)) return;
  clearTimeout(stickyTimers.get(channel.id));
  stickyTimers.set(channel.id, setTimeout(() => {
    stickyTimers.delete(channel.id);
    repostSticky(channel).catch((e) => console.error('Sticky:', e));
  }, STICKY_DELAY_MS));
}

// ---- Reminders ------------------------------------------------------------------------------

async function deliverReminders(client) {
  for (const r of db.prepare('SELECT * FROM reminders WHERE due_at <= ?').all(Date.now())) {
    db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
    const text = `⏰ <@${r.user_id}>, reminder: ${r.text}`;
    const channel = !r.dm && r.channel_id && client.channels.cache.get(r.channel_id);
    const sent = channel && await channel.send({ content: text, allowedMentions: { users: [r.user_id] } }).then(() => true, () => false);
    if (!sent) await client.users.fetch(r.user_id).then((u) => u.send(text)).catch(() => {});
  }
}

// ---- Wiring ---------------------------------------------------------------------------------

function register(client) {
  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild() || message.author.id === client.user.id) return;
    scheduleSticky(message.channel);
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.GuildAnnouncement
      && getFeature(message.guildId, 'autopublish', { channels: [] }).channels.includes(message.channelId)) {
      // Discord allows about 10 publishes per hour per channel; extra ones just fail quietly.
      message.crosspost().catch(() => {});
    }
    // Responders read message text, which needs the Message Content intent.
    if (client.hasMessageContent) respond(message).catch((e) => console.error('Auto-responder:', e));
  });
}

module.exports = { register, matchResponder, repostSticky, deliverReminders };
