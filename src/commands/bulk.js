const { SlashCommandBuilder, Colors, InteractionContextType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { formatDuration } = require('../monitor');
const { BRAND, ephemeral, parseDuration, confirm } = require('../util');
const mod = require('../moderation');

const MAX_IDS = 200;
const idsOption = (o) => o.setName('users').setDescription('User IDs or mentions, separated by spaces or commas').setRequired(true);

function summary(done, failed, verb) {
  const lines = [`✅ ${verb} ${done}.`];
  if (failed.length) lines.push(`❌ Skipped ${failed.length}:`, ...failed.slice(0, 15).map((f) => `• ${f}`));
  if (failed.length > 15) lines.push(`…and ${failed.length - 15} more`);
  return lines.join('\n');
}

// Kicks or times out each ID in turn, so one protected member doesn't stop the rest.
async function eachMember(i, ids, action, run) {
  let done = 0;
  const failed = [];
  for (const id of ids) {
    const member = await i.guild.members.fetch(id).catch(() => null);
    const error = mod.checkTarget(i.member, member, action);
    if (error) { failed.push(`\`${id}\`: ${error}`); continue; }
    try { await run(member); done++; } catch (e) { failed.push(`\`${id}\`: ${e.message}`); }
  }
  return { done, failed };
}

async function bulkRole(i, give) {
  const role = i.options.getRole('role', true);
  const filter = i.options.getRole('only_with');
  if (role.managed || role.id === i.guildId) return i.reply(ephemeral("That role can't be handed out."));
  if (role.position >= i.guild.members.me.roles.highest.position) return i.reply(ephemeral(`I can't manage ${role}. Move my role above it.`));
  if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) return i.reply(ephemeral(`${role} is equal to or above your highest role.`));

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const members = (await i.guild.members.fetch())
    .filter((m) => !m.user.bot && (!filter || m.roles.cache.has(filter.id)) && m.roles.cache.has(role.id) !== give);
  if (!members.size) return i.editReply('Nobody needs changing.');

  const who = filter ? `members with ${filter}` : 'members';
  const button = await confirm(i, `${give ? 'Give' : 'Take'} ${role} ${give ? 'to' : 'from'} **${members.size}** ${who}?`, give ? 'Give role' : 'Take role');
  if (!button) return;
  await button.update({ content: `⏳ Working on ${members.size} members…`, components: [] });

  // ponytail: one request per member; a 10k-member server takes minutes. Progress edits keep the user informed.
  let done = 0;
  const failed = [];
  for (const member of members.values()) {
    try {
      await (give ? member.roles.add(role, mod.auditReason(i.member, 'Bulk role')) : member.roles.remove(role, mod.auditReason(i.member, 'Bulk role')));
      done++;
    } catch (e) {
      failed.push(`${member.user.tag}: ${e.message}`);
    }
    if ((done + failed.length) % 25 === 0) await i.editReply(`⏳ ${done + failed.length}/${members.size}…`).catch(() => {});
  }
  await mod.modLog(i.guild, { title: `🏷️ Bulk role ${give ? 'given' : 'taken'}`, color: BRAND, moderator: i.user, extra: `**Role:** ${role}\n**Members:** ${done}` });
  await i.editReply(summary(done, failed, give ? 'Gave the role to' : 'Took the role from'));
}

async function bulk(i) {
  const sub = i.options.getSubcommand();
  if (sub === 'role-give' || sub === 'role-take') return bulkRole(i, sub === 'role-give');

  const ids = mod.parseIds(i.options.getString('users', true));
  if (!ids.length) return i.reply(ephemeral('I found no user IDs in that.'));
  if (ids.length > MAX_IDS) return i.reply(ephemeral(`That's ${ids.length} users. The limit is ${MAX_IDS} per command.`));
  const reason = i.options.getString('reason') ?? 'No reason given';
  const audit = mod.auditReason(i.member, `Bulk ${sub}: ${reason}`);

  let ms;
  if (sub === 'timeout') {
    ms = parseDuration(i.options.getString('duration', true));
    if (!ms || ms > mod.MAX_TIMEOUT_MS) return i.reply(ephemeral('Use a duration like `10m`, `1h` or `2d`, up to 28 days.'));
  }

  const button = await confirm(i, `${sub[0].toUpperCase()}${sub.slice(1)} **${ids.length}** users? Reason: ${reason}`, `${sub[0].toUpperCase()}${sub.slice(1)} ${ids.length}`);
  if (!button) return;
  await button.update({ content: `⏳ Working on ${ids.length} users…`, components: [] });

  // One case per user, without flooding the mod log; the summary below covers them.
  const record = (action, user, extra = {}) =>
    mod.recordCase(i.guild, { action, user, moderator: i.user, reason: `Bulk: ${reason}`, log: false, ...extra });

  let result;
  if (sub === 'ban') {
    // Discord's bulk ban endpoint does up to 200 in one request, members or not.
    try {
      const { bannedUsers, failedUsers } = await i.guild.bans.bulkCreate(ids, { reason: audit, deleteMessageSeconds: 3600 });
      result = { done: bannedUsers.length, failed: failedUsers.map((id) => `\`${id}\`: already banned or protected`) };
      for (const id of bannedUsers) {
        mod.closeBans(i.guildId, id);
        await record('ban', i.client.users.cache.get(id) ?? { id, tag: id });
      }
    } catch (e) {
      return i.editReply(`❌ Bulk ban failed: ${e.message}`);
    }
  } else if (sub === 'kick') {
    result = await eachMember(i, ids, 'kick', async (m) => { await m.kick(audit); await record('kick', m.user); });
  } else {
    result = await eachMember(i, ids, 'timeout', async (m) => { await m.timeout(ms, audit); await record('timeout', m.user, { durationMs: ms }); });
  }

  const verb = { ban: 'Banned', kick: 'Kicked', timeout: `Timed out for ${formatDuration(ms ?? 0)}` }[sub];
  await mod.modLog(i.guild, { title: `🧨 Bulk ${sub}`, color: Colors.Red, moderator: i.user, reason, extra: `**Affected:** ${result.done} of ${ids.length}` });
  await i.editReply(summary(result.done, result.failed, verb));
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('bulk')
      .setDescription('Act on many members at once (administrators only)')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('ban').setDescription(`Ban up to ${MAX_IDS} users and delete their last hour of messages`)
        .addStringOption(idsOption).addStringOption(mod.reasonOption))
      .addSubcommand((s) => s.setName('kick').setDescription(`Kick up to ${MAX_IDS} members`)
        .addStringOption(idsOption).addStringOption(mod.reasonOption))
      .addSubcommand((s) => s.setName('timeout').setDescription(`Time out up to ${MAX_IDS} members`)
        .addStringOption(idsOption)
        .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d (max 28d)').setRequired(true))
        .addStringOption(mod.reasonOption))
      .addSubcommand((s) => s.setName('role-give').setDescription('Give a role to every member')
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true))
        .addRoleOption((o) => o.setName('only_with').setDescription('Only members who have this role')))
      .addSubcommand((s) => s.setName('role-take').setDescription('Take a role from every member')
        .addRoleOption((o) => o.setName('role').setDescription('Role to take').setRequired(true))
        .addRoleOption((o) => o.setName('only_with').setDescription('Only members who have this role'))),
    execute: bulk,
  },
];
