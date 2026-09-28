// Daily copies of each server's roles and channels. If a hijacked admin account deletes them,
// /restore rebuilds what is missing: roles (with their members), categories and channels.
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { db } = require('./db');
const journal = require('./journal');

const KEEP = 7;
const EVERY_MS = 24 * 3_600_000;

async function take(guild) {
  // Role members come from the member cache, so load everyone first.
  // ponytail: holds every member in memory once a day; fine up to ~100k members.
  await guild.members.fetch().catch(() => null);
  const data = {
    roles: guild.roles.cache
      .filter((r) => !r.managed && r.id !== guild.id)
      .map((r) => ({
        id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(), position: r.position, members: [...r.members.keys()],
      })),
    channels: guild.channels.cache.filter((c) => !c.isThread()).map((c) => journal.channelSnapshot(c, [])),
  };
  const { lastInsertRowid } = db.prepare('INSERT INTO server_snapshots (guild_id, taken_at, data) VALUES (?, ?, ?)')
    .run(guild.id, Date.now(), JSON.stringify(data));
  db.prepare('DELETE FROM server_snapshots WHERE guild_id = ? AND id NOT IN (SELECT id FROM server_snapshots WHERE guild_id = ? ORDER BY taken_at DESC LIMIT ?)')
    .run(guild.id, guild.id, KEEP);
  return { id: Number(lastInsertRowid), roles: data.roles.length, channels: data.channels.length };
}

const list = (guildId) => db.prepare('SELECT id, taken_at, data FROM server_snapshots WHERE guild_id = ? ORDER BY taken_at DESC').all(guildId)
  .map((s) => ({ ...s, data: JSON.parse(s.data) }));

const get = (guildId, id) => list(guildId).find((s) => s.id === id) ?? null;

// What the snapshot has that the server no longer does.
function missing(guild, snapshot) {
  const roles = snapshot.data.roles.filter((r) => !guild.roles.cache.has(r.id)).sort((a, b) => a.position - b.position);
  const channels = snapshot.data.channels.filter((c) => !guild.channels.cache.has(c.id))
    // Categories first, so channels can go back inside them.
    .sort((a, b) => (b.type === ChannelType.GuildCategory) - (a.type === ChannelType.GuildCategory) || a.position - b.position);
  return { roles, channels };
}

async function restore(guild, snapshot, progress = async () => {}) {
  const { roles, channels } = missing(guild, snapshot);
  const me = guild.members.me;
  // Discord refuses roles with permissions the bot itself doesn't have.
  const allowed = me.permissions.has(PermissionFlagsBits.Administrator) ? null : me.permissions.bitfield;
  const ctx = { ids: {}, reason: 'Restore from snapshot' };
  const failed = [];
  const done = { roles: 0, channels: 0, members: 0, moved: 0 };

  for (const r of roles) {
    try {
      const permissions = allowed === null ? BigInt(r.permissions) : BigInt(r.permissions) & allowed;
      const role = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions, reason: ctx.reason });
      journal.created('role', role);
      ctx.ids[r.id] = role.id;
      journal.remapId(guild.id, r.id, role.id);
      done.roles++;
    } catch (e) {
      failed.push(`Role ${r.name}: ${e.message}`);
    }
  }
  // Put recreated roles back in their old order, as high as the bot is allowed to place them.
  const top = me.roles.highest.position - 1;
  await guild.roles.setPositions(roles.filter((r) => ctx.ids[r.id]).map((r) => ({ role: ctx.ids[r.id], position: Math.min(r.position, top) }))).catch(() => {});
  await progress(`Recreated ${done.roles} roles…`);

  for (const c of channels) {
    try {
      journal.created('channel', await journal.recreateChannel(guild, { ...c, children: [] }, ctx));
      done.channels++;
    } catch (e) {
      failed.push(`#${c.name}: ${e.message}`);
    }
  }
  // Channels that survived but lost their category go back into the recreated one.
  for (const c of snapshot.data.channels) {
    const now = guild.channels.cache.get(c.id);
    if (now && !now.parentId && ctx.ids[c.parentId]) {
      if (await now.setParent(ctx.ids[c.parentId], { lockPermissions: false, reason: ctx.reason }).then(() => true, () => false)) done.moved++;
    }
  }
  await progress(`Recreated ${done.roles} roles and ${done.channels} channels. Giving roles back to members…`);

  for (const r of roles) {
    if (!ctx.ids[r.id]) continue;
    for (const memberId of r.members) {
      const member = guild.members.cache.get(memberId);
      if (member && await member.roles.add(ctx.ids[r.id], ctx.reason).then(() => true, () => false)) done.members++;
    }
  }
  return { ...done, failed };
}

// Called on the scheduler tick: one server per tick whose latest snapshot is a day old.
async function autoTake(client, now = Date.now()) {
  for (const guild of client.guilds.cache.values()) {
    const last = db.prepare('SELECT MAX(taken_at) AS at FROM server_snapshots WHERE guild_id = ?').get(guild.id).at ?? 0;
    if (now - last >= EVERY_MS) return take(guild);
  }
  return null;
}

module.exports = { take, list, get, missing, restore, autoTake, KEEP };
