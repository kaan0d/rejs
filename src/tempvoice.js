const { ChannelType, Events, PermissionFlagsBits } = require('discord.js');
const { db, getFeature } = require('./db');

const P = PermissionFlagsBits;
const tempChannel = (channelId) => db.prepare('SELECT * FROM temp_voice WHERE channel_id = ?').get(channelId);

async function createFor(member, hub) {
  const owned = db.prepare('SELECT channel_id FROM temp_voice WHERE guild_id = ? AND owner_id = ?').get(member.guild.id, member.id);
  const existing = owned && member.guild.channels.cache.get(owned.channel_id);
  if (existing) return member.voice.setChannel(existing).catch(() => {});

  const channel = await member.guild.channels.create({
    name: `${member.displayName}'s channel`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: hub.parentId,
    // Start from the category's permissions, and make sure the owner can always get in.
    permissionOverwrites: [
      ...[...(hub.parent?.permissionOverwrites.cache.values() ?? [])].filter((o) => o.id !== member.id),
      { id: member.id, allow: [P.ViewChannel, P.Connect, P.Speak] },
    ],
    reason: `Temporary channel for ${member.user.tag}`,
  });
  db.prepare('INSERT INTO temp_voice (channel_id, guild_id, owner_id) VALUES (?, ?, ?)').run(channel.id, member.guild.id, member.id);
  // The member list updates a moment after the move, so trust the move result instead of checking it.
  const moved = await member.voice.setChannel(channel).then(() => true, () => false);
  if (!moved) {
    // They left the hub before we could move them.
    db.prepare('DELETE FROM temp_voice WHERE channel_id = ?').run(channel.id);
    await channel.delete('Owner left before the move').catch(() => {});
  }
}

async function removeIfEmpty(channel) {
  if (!channel || channel.members.size) return;
  db.prepare('DELETE FROM temp_voice WHERE channel_id = ?').run(channel.id);
  await channel.delete('Temporary channel is empty').catch(() => {});
}

async function onVoiceUpdate(before, after) {
  const { hubId } = getFeature(after.guild.id, 'tempvoice', {});
  if (hubId && after.channelId === hubId && before.channelId !== hubId) {
    const hub = after.guild.channels.cache.get(hubId);
    if (hub) await createFor(after.member, hub);
  }
  if (before.channelId && before.channelId !== after.channelId && tempChannel(before.channelId)) {
    await removeIfEmpty(before.channel);
  }
}

// Channels emptied while the bot was offline are cleaned up at startup.
async function cleanup(client) {
  for (const row of db.prepare('SELECT * FROM temp_voice').all()) {
    const channel = client.channels.cache.get(row.channel_id);
    if (!channel) db.prepare('DELETE FROM temp_voice WHERE channel_id = ?').run(row.channel_id);
    else await removeIfEmpty(channel);
  }
}

const setOwner = (channelId, userId) => db.prepare('UPDATE temp_voice SET owner_id = ? WHERE channel_id = ?').run(userId, channelId);

const register = (client) =>
  client.on(Events.VoiceStateUpdate, (before, after) => onVoiceUpdate(before, after).catch((e) => console.error('Temp voice:', e)));

module.exports = { register, cleanup, tempChannel, setOwner };
