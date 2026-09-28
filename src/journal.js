// Undo journal. Each staff command runs as one entry: database changes are captured by triggers
// (see db.js), and Discord changes are recorded here as steps that say how to reverse them.
const { AsyncLocalStorage } = require('node:async_hooks');
const { PermissionsBitField, OverwriteType } = require('discord.js');
const { rawPrepare, db, setTxProvider } = require('./db');

const KEEP_MS = 7 * 86_400_000;
const als = new AsyncLocalStorage();

const insertEntry = rawPrepare('INSERT INTO undo_log (guild_id, user_id, label, permissions, created_at) VALUES (?, ?, ?, ?, ?)');

// The entry row is created on the first change, so read-only commands leave nothing behind.
function txId() {
  const tx = als.getStore();
  if (!tx) return null;
  tx.id ??= Number(insertEntry.run(tx.guildId, tx.userId, tx.label, tx.permissions, Date.now()).lastInsertRowid);
  return tx.id;
}
setTxProvider(txId);

// Runs fn as one journal entry. meta: { guildId, userId, label, permissions }.
async function run(meta, fn) {
  const tx = { ...meta, id: null, steps: [], notes: [] };
  try {
    return await als.run(tx, fn);
  } finally {
    // Discord-only commands (no database change yet) still need their entry row.
    if ((tx.steps.length || tx.notes.length) && !tx.id) als.run(tx, txId);
    if (tx.id) {
      rawPrepare('UPDATE undo_log SET steps = ?, notes = ? WHERE id = ?').run(JSON.stringify(tx.steps), JSON.stringify(tx.notes), tx.id);
    }
  }
}

const record = (step) => als.getStore()?.steps.push(step);
// Things that can't be taken back, like a kick or deleted messages. Shown before undoing.
const cannotUndo = (note) => {
  const tx = als.getStore();
  if (tx && !tx.notes.includes(note)) tx.notes.push(note);
};

// ---- Recorders: call these right before or after changing something on Discord ------------

const overwriteOf = (channel, targetId) => {
  const o = channel.permissionOverwrites?.cache.get(targetId);
  return o ? { allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() } : null;
};

// Everything needed to recreate a channel: settings, place in the list and permissions.
// children: channels that stay after a category-only delete and should move back under it.
const channelSnapshot = (c, children) => ({
  id: c.id,
  name: c.name,
  type: c.type,
  parentId: c.parentId ?? null,
  position: c.rawPosition,
  topic: c.topic ?? null,
  nsfw: c.nsfw ?? false,
  rateLimitPerUser: c.rateLimitPerUser ?? null,
  bitrate: c.bitrate ?? null,
  userLimit: c.userLimit ?? null,
  overwrites: [...(c.permissionOverwrites?.cache.values() ?? [])]
    .map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })),
  children,
});

// After a channel is recreated with a new ID, points the bot's saved settings (log channels,
// stickies, schedules, other undo entries...) at the new channel.
function remapId(guildId, oldId, newId) {
  const tables = rawPrepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
  for (const table of tables) {
    const columns = rawPrepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === 'guild_id')) continue;
    for (const { name, type } of columns) {
      if (type !== 'TEXT' || name === 'guild_id') continue;
      rawPrepare(`UPDATE ${table} SET ${name} = REPLACE(${name}, ?, ?) WHERE guild_id = ? AND instr(${name}, ?) > 0`).run(oldId, newId, guildId, oldId);
    }
  }
}

async function recreateChannel(guild, s, ctx) {
  // A parent category recreated earlier in this same undo has a new ID.
  const parentId = ctx.ids[s.parentId] ?? s.parentId;
  const created = await guild.channels.create({
    name: s.name,
    type: s.type,
    parent: guild.channels.cache.has(parentId) ? parentId : null,
    position: s.position,
    topic: s.topic ?? undefined,
    nsfw: s.nsfw,
    rateLimitPerUser: s.rateLimitPerUser ?? undefined,
    bitrate: s.bitrate ?? undefined,
    userLimit: s.userLimit ?? undefined,
    // Overwrites for roles deleted since then would make Discord reject the whole channel.
    permissionOverwrites: s.overwrites
      .filter((o) => o.type !== OverwriteType.Role || guild.roles.cache.has(o.id))
      .map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) })),
    reason: 'Undo',
  });
  ctx.ids[s.id] = created.id;
  remapId(guild.id, s.id, created.id);
  for (const childId of s.children) {
    await guild.channels.cache.get(childId)?.setParent(created.id, { lockPermissions: false, reason: 'Undo' }).catch(() => {});
  }
  return created;
}

const journal = {
  run,
  cannotUndo,
  created: (kind, target) => record(kind === 'message'
    ? { type: 'deleteMessage', channelId: target.channelId, messageId: target.id }
    : { type: kind === 'role' ? 'deleteRole' : 'deleteChannel', id: target.id }),
  // Call before editing a permission overwrite.
  overwrite: (channel, targetId) => record({
    type: 'overwrite', channelId: channel.id, targetId, previous: overwriteOf(channel, targetId),
    targetType: channel.guild.roles.cache.has(targetId) ? OverwriteType.Role : OverwriteType.Member,
  }),
  // Call before editing a channel setting, e.g. ('rateLimitPerUser', 0).
  channelField: (channel, field) => record({ type: 'channelField', channelId: channel.id, field, previous: channel[field] }),
  verificationLevel: (guild) => record({ type: 'verificationLevel', previous: guild.verificationLevel }),
  memberRole: (member, roleId, added) => record({ type: 'memberRole', userId: member.id, roleId, added }),
  nickname: (member) => record({ type: 'nickname', userId: member.id, previous: member.nickname }),
  timeout: (member) => record({ type: 'timeout', userId: member.id, previous: member.communicationDisabledUntilTimestamp ?? null }),
  banned: (userId) => record({ type: 'unban', userId }),
  unbanned: (userId) => record({ type: 'ban', userId }),
  threadMember: (thread, userId, added) => record({ type: 'threadMember', threadId: thread.id, userId, added }),
  automod: (rule, previous) => record(previous
    ? { type: 'restoreAutomod', id: rule.id, previous }
    : { type: 'deleteAutomod', id: rule.id }),
  deletedAutomod: (rule) => record({ type: 'recreateAutomod', rule }),
  // Call before deleting a channel or category. Undo recreates it (without its messages).
  deletedChannel: (channel, children = []) => record({ type: 'recreateChannel', snapshot: channelSnapshot(channel, children) }),
  // Re-renders a message from the restored database once the undo is done.
  refresh: (kind, id) => record({ type: 'refresh', kind, id }),
};

// ---- Undo -----------------------------------------------------------------------------------

const entry = (id) => rawPrepare('SELECT * FROM undo_log WHERE id = ?').get(id);

const undoable = (guildId, now = Date.now()) =>
  rawPrepare('SELECT * FROM undo_log WHERE guild_id = ? AND undone_at IS NULL AND created_at > ? ORDER BY id DESC LIMIT 25').all(guildId, now - KEEP_MS);

const changesOf = (id) => rawPrepare('SELECT * FROM undo_rows WHERE tx = ? ORDER BY id DESC').all(id);

// Puts every captured row back the way it was, newest change first.
function undoRows(id) {
  let count = 0;
  for (const change of changesOf(id)) {
    const old = change.old && JSON.parse(change.old);
    if (change.op === 'insert') {
      rawPrepare(`DELETE FROM ${change.tbl} WHERE rowid = ?`).run(change.row_id);
    } else if (change.op === 'update') {
      const columns = Object.keys(old);
      rawPrepare(`UPDATE ${change.tbl} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE rowid = ?`).run(...Object.values(old), change.row_id);
    } else {
      const columns = Object.keys(old);
      rawPrepare(`INSERT OR REPLACE INTO ${change.tbl} (rowid, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`)
        .run(change.row_id, ...Object.values(old));
    }
    count++;
  }
  return count;
}

// Reverses one Discord step. Throws when Discord refuses; the caller reports it.
async function undoStep(guild, step, ctx) {
  const channel = () => guild.channels.cache.get(step.channelId);
  const member = () => guild.members.fetch(step.userId);
  const reason = 'Undo';
  switch (step.type) {
    case 'deleteChannel': return guild.channels.cache.get(step.id)?.delete(reason);
    case 'deleteRole': return guild.roles.cache.get(step.id)?.delete(reason);
    case 'deleteMessage': return channel()?.messages.delete(step.messageId);
    case 'overwrite':
      if (!channel()) return null;
      // create() replaces the whole overwrite, so bits added since then are cleared too.
      return step.previous
        ? channel().permissionOverwrites.create(step.targetId, bitsToOptions(step.previous), { reason, type: step.targetType })
        : channel().permissionOverwrites.delete(step.targetId, reason);
    case 'channelField': return channel()?.edit({ [step.field]: step.previous, reason });
    case 'verificationLevel': return guild.setVerificationLevel(step.previous, reason);
    case 'memberRole': return (await member())?.roles[step.added ? 'remove' : 'add'](step.roleId, reason);
    case 'nickname': return (await member())?.setNickname(step.previous, reason);
    case 'timeout': {
      const until = step.previous && step.previous > Date.now() ? step.previous - Date.now() : null;
      return (await member())?.timeout(until, reason);
    }
    case 'unban': return guild.bans.remove(step.userId, reason);
    case 'ban': return guild.bans.create(step.userId, { reason });
    case 'threadMember': {
      const thread = await guild.channels.fetch(step.threadId).catch(() => null);
      return step.added ? thread?.members.remove(step.userId) : thread?.members.add(step.userId);
    }
    case 'deleteAutomod': return guild.autoModerationRules.delete(step.id, reason);
    case 'restoreAutomod': return guild.autoModerationRules.edit(step.id, { ...step.previous, reason });
    case 'recreateAutomod': return guild.autoModerationRules.create({ ...step.rule, reason });
    case 'recreateChannel': return recreateChannel(guild, step.snapshot, ctx);
    case 'refresh': return ctx.refreshers[step.kind]?.(guild, step.id);
    default: return null;
  }
}

// Permission bitfields back into the { Name: true/false } form discord.js edits with.
function bitsToOptions({ allow, deny }) {
  const options = {};
  for (const name of new PermissionsBitField(BigInt(allow)).toArray()) options[name] = true;
  for (const name of new PermissionsBitField(BigInt(deny)).toArray()) options[name] = false;
  return options;
}

// Undoes a whole entry: database first, then Discord steps newest first, then refreshes.
async function undo(guild, id, userId, refreshers = {}) {
  const e = entry(id);
  if (!e || e.guild_id !== guild.id || e.undone_at) return null;
  rawPrepare('UPDATE undo_log SET undone_at = ?, undone_by = ? WHERE id = ?').run(Date.now(), userId, id);

  // All row changes go back together, or none do.
  db.exec('BEGIN');
  let rows;
  try {
    rows = undoRows(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    rawPrepare('UPDATE undo_log SET undone_at = NULL, undone_by = NULL WHERE id = ?').run(id);
    throw error;
  }
  const steps = JSON.parse(e.steps);
  const failed = [];
  // Refresh steps were recorded first, so running in reverse leaves them for last.
  const ctx = { refreshers, ids: {} };
  for (const step of [...steps].reverse()) {
    await undoStep(guild, step, ctx).catch((err) => failed.push(`${step.type}: ${err.message}`));
  }
  return { rows, steps: steps.filter((s) => s.type !== 'refresh').length, failed, notes: JSON.parse(e.notes) };
}

// Newer entries that may conflict: undoing an older change can overwrite them.
const newerThan = (guildId, id) =>
  rawPrepare('SELECT COUNT(*) AS n FROM undo_log WHERE guild_id = ? AND id > ? AND undone_at IS NULL').get(guildId, id).n;

function purgeOld(now = Date.now()) {
  rawPrepare('DELETE FROM undo_log WHERE created_at < ?').run(now - KEEP_MS);
  rawPrepare('DELETE FROM undo_rows WHERE tx NOT IN (SELECT id FROM undo_log)').run();
}

module.exports = { ...journal, undo, undoable, entry, changesOf, newerThan, purgeOld, KEEP_MS };
