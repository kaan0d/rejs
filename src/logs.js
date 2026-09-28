const { EmbedBuilder, Colors, AttachmentBuilder, Events, escapeMarkdown } = require('discord.js');
const { db, getSettings } = require('./db');
const { BRAND } = require('./util');

const COLUMNS = { messages: 'message_log_id', members: 'member_log_id', voice: 'voice_log_id' };
const NEW_ACCOUNT_MS = 7 * 86_400_000;
const unix = (ms) => Math.floor(ms / 1000);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Ignored channels also cover their threads.
function isIgnored(guildId, channel, member) {
  const ids = new Set(db.prepare('SELECT target_id FROM log_ignores WHERE guild_id = ?').all(guildId).map((r) => r.target_id));
  if (!ids.size) return false;
  if (channel && (ids.has(channel.id) || ids.has(channel.parentId))) return true;
  return Boolean(member?.roles?.cache.some((r) => ids.has(r.id)));
}

async function send(guild, type, payload) {
  const id = getSettings(guild.id)[COLUMNS[type]];
  const channel = id && guild.channels.cache.get(id);
  await channel?.send({ allowedMentions: { parse: [] }, ...payload }).catch(() => {});
}

const who = (user) => (user ? `${user} (${escapeMarkdown(user.tag)} · \`${user.id}\`)` : 'Unknown');

function register(client) {
  // Without the Message Content intent Discord sends empty text, so say so instead of logging blanks.
  const contentOf = (message) => {
    if (!client.hasMessageContent) return '*Content unavailable: the Message Content intent is off.*';
    if (message.partial) return '*Not cached: sent before the bot last started.*';
    return message.content ? clip(message.content, 1024) : '*No text*';
  };

  client.on(Events.MessageUpdate, async (before, after) => {
    if (after.partial || !after.inGuild() || after.author.bot || !client.hasMessageContent) return;
    if (!before.partial && before.content === after.content) return; // link previews loading, pins, etc.
    if (isIgnored(after.guildId, after.channel, after.member)) return;
    await send(after.guild, 'messages', {
      embeds: [new EmbedBuilder()
        .setColor(Colors.Yellow)
        .setAuthor({ name: `✏️ Message edited · ${after.author.tag}`, iconURL: after.author.displayAvatarURL() })
        .setDescription(`${who(after.author)} in ${after.channel} · [Jump](${after.url})`)
        .addFields({ name: 'Before', value: contentOf(before) }, { name: 'After', value: contentOf(after) })
        .setTimestamp()],
    });
  });

  client.on(Events.MessageDelete, async (message) => {
    // Uncached deletes carry no author or text, so "unknown deleted something" would only be noise;
    // it would also log the bot's own sticky reposts after a restart.
    if (message.partial || !message.inGuild() || message.author.bot) return;
    if (isIgnored(message.guildId, message.channel, message.member)) return;
    const files = message.attachments?.map((a) => a.name).join(', ');
    await send(message.guild, 'messages', {
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setAuthor({ name: '🗑️ Message deleted', iconURL: message.author?.displayAvatarURL() })
        .setDescription(`${who(message.author)} in ${message.channel}`)
        .addFields(
          { name: 'Content', value: contentOf(message) },
          ...(files ? [{ name: 'Attachments', value: clip(files, 1024) }] : []),
        )
        .setTimestamp()],
    });
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!channel.guild || isIgnored(channel.guildId, channel)) return;
    const lines = [...messages.values()].reverse().map((m) => m.partial
      ? `[${m.id}] (not cached)`
      : `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${client.hasMessageContent ? m.content : '(content unavailable)'}`);
    await send(channel.guild, 'messages', {
      embeds: [new EmbedBuilder().setColor(Colors.Red).setTitle(`🧹 ${messages.size} messages bulk deleted`).setDescription(`In ${channel}`).setTimestamp()],
      files: [new AttachmentBuilder(Buffer.from(lines.join('\n')), { name: `deleted-${channel.id}.txt` })],
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (isIgnored(member.guild.id, null, member)) return;
    const young = Date.now() - member.user.createdTimestamp < NEW_ACCOUNT_MS;
    await send(member.guild, 'members', {
      embeds: [new EmbedBuilder()
        .setColor(young ? Colors.Orange : Colors.Green)
        .setAuthor({ name: `📥 Member joined${young ? ' · 🆕 new account' : ''}`, iconURL: member.displayAvatarURL() })
        .setDescription(`${who(member.user)}\nAccount created <t:${unix(member.user.createdTimestamp)}:R>`)
        .setFooter({ text: `Member #${member.guild.memberCount}` })
        .setTimestamp()],
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (isIgnored(member.guild.id, null, member)) return;
    const roles = member.partial ? null : member.roles.cache.filter((r) => r.id !== member.guild.id).map((r) => `${r}`).join(' ');
    const joined = member.joinedTimestamp ? `\nJoined <t:${unix(member.joinedTimestamp)}:R>` : '';
    await send(member.guild, 'members', {
      embeds: [new EmbedBuilder()
        .setColor(Colors.Grey)
        .setAuthor({ name: '📤 Member left', iconURL: member.user.displayAvatarURL() })
        .setDescription(`${who(member.user)}${joined}`)
        .addFields({ name: 'Roles', value: roles ? clip(roles, 1024) : roles === null ? '*Unknown*' : 'None' })
        .setTimestamp()],
    });
  });

  client.on(Events.GuildMemberUpdate, async (before, after) => {
    if (before.partial || isIgnored(after.guild.id, null, after)) return;
    const fields = [];
    if (before.nickname !== after.nickname) {
      fields.push({ name: '🏷️ Nickname', value: `${escapeMarkdown(before.nickname ?? '*none*')} → ${escapeMarkdown(after.nickname ?? '*none*')}` });
    }
    const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
    const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
    if (added.size || removed.size) {
      fields.push({ name: '🎭 Roles', value: clip([...added.map((r) => `+ ${r}`), ...removed.map((r) => `− ${r}`)].join('\n'), 1024) });
    }
    if (before.communicationDisabledUntilTimestamp !== after.communicationDisabledUntilTimestamp) {
      fields.push({
        name: '🔇 Timeout',
        value: after.isCommunicationDisabled() ? `Until <t:${unix(after.communicationDisabledUntilTimestamp)}:f>` : 'Removed',
      });
    }
    if (!fields.length) return;
    await send(after.guild, 'members', {
      embeds: [new EmbedBuilder()
        .setColor(BRAND)
        .setAuthor({ name: '✳️ Member updated', iconURL: after.displayAvatarURL() })
        .setDescription(who(after.user))
        .addFields(fields)
        .setTimestamp()],
    });
  });

  client.on(Events.VoiceStateUpdate, async (before, after) => {
    if (before.channelId === after.channelId || after.member?.user.bot) return;
    if (isIgnored(after.guild.id, after.channel ?? before.channel, after.member)) return;
    const text = !before.channel ? `🔊 Joined ${after.channel}`
      : !after.channel ? `🔈 Left ${before.channel}`
      : `🔀 Moved ${before.channel} → ${after.channel}`;
    await send(after.guild, 'voice', {
      embeds: [new EmbedBuilder()
        .setColor(!after.channel ? Colors.Grey : Colors.Green)
        .setAuthor({ name: after.member.user.tag, iconURL: after.member.displayAvatarURL() })
        .setDescription(`${after.member} ${text}`)
        .setTimestamp()],
    });
  });
}

module.exports = { register, COLUMNS };
