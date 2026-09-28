const { SlashCommandBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { BRAND, ephemeral, confirm } = require('../util');
const mod = require('../moderation');
const journal = require('../journal');

const command = (name, description, permission) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(permission);

// Returns why this role can't be handed out by this moderator, or null.
function checkRole(i, role) {
  if (role.managed || role.id === i.guildId) return `${role} is managed by Discord or an integration.`;
  if (!role.editable) return `I can't manage ${role}. Move my role above it.`;
  if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) return `${role} is equal to or above your highest role.`;
  return null;
}

async function roleCommand(i) {
  const give = i.options.getSubcommand() === 'add';
  const member = i.options.getMember('user');
  const role = i.options.getRole('role', true);
  if (!member) return i.reply(ephemeral('That user is not in this server.'));
  const error = checkRole(i, role);
  if (error) return i.reply(ephemeral(error));
  if (member.roles.cache.has(role.id) === give) return i.reply(ephemeral(`${member} ${give ? 'already has' : "doesn't have"} ${role}.`));

  const reason = i.options.getString('reason') ?? 'No reason given';
  await (give ? member.roles.add(role, mod.auditReason(i.member, reason)) : member.roles.remove(role, mod.auditReason(i.member, reason)));
  journal.memberRole(member, role.id, give);
  await mod.modLog(i.guild, {
    title: give ? 'Role given' : 'Role taken', color: BRAND, target: member.user, moderator: i.user, reason, extra: `**Role:** ${role}`,
  });
  await i.reply(ephemeral(`✅ ${give ? 'Gave' : 'Took'} ${role} ${give ? 'to' : 'from'} ${member}.`));
}

async function decancerCommand(i) {
  const member = i.options.getMember('user');
  if (i.options.getUser('user')) {
    const error = mod.checkTarget(i.member, member, 'nick');
    if (error) return i.reply(ephemeral(error));
    const clean = mod.decancer(member.displayName);
    if (clean === member.displayName) return i.reply(ephemeral(`${member}'s name is already readable.`));
    journal.nickname(member);
    await member.setNickname(clean, mod.auditReason(i.member, 'Decancer'));
    return i.reply(ephemeral(`✅ Renamed ${member} to **${clean}**.`));
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const targets = (await i.guild.members.fetch())
    .filter((m) => !m.user.bot && m.manageable && mod.decancer(m.displayName) !== m.displayName);
  if (!targets.size) return i.editReply('Every name I can change is already readable.');

  const preview = targets.first(5).map((m) => `${m.displayName} → ${mod.decancer(m.displayName)}`).join('\n');
  const button = await confirm(i, `Rename **${targets.size}** members? For example:\n${preview}`, `Rename ${targets.size}`);
  if (!button) return;
  await button.update({ content: `Renaming ${targets.size} members…`, components: [] });

  let done = 0;
  for (const m of targets.values()) {
    journal.nickname(m);
    if (await m.setNickname(mod.decancer(m.displayName), mod.auditReason(i.member, 'Decancer')).then(() => true, () => false)) done++;
  }
  await mod.modLog(i.guild, { title: 'Names cleaned', color: BRAND, moderator: i.user, extra: `**Renamed:** ${done} members` });
  await i.editReply(`✅ Renamed ${done} of ${targets.size} members.`);
}

module.exports = [
  {
    data: command('role', "Give or take one member's role", PermissionFlagsBits.ManageRoles)
      .addSubcommand((s) => s.setName('add').setDescription('Give a member a role')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption(mod.reasonOption))
      .addSubcommand((s) => s.setName('remove').setDescription("Take a member's role")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption(mod.reasonOption)),
    execute: roleCommand,
  },

  {
    data: command('nick', "Change or reset a member's nickname", PermissionFlagsBits.ManageNicknames)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('nickname').setDescription('Leave empty to reset').setMaxLength(32)),
    async execute(i) {
      const member = i.options.getMember('user');
      const error = mod.checkTarget(i.member, member, 'nick');
      if (error) return i.reply(ephemeral(error));
      const nickname = i.options.getString('nickname');
      journal.nickname(member);
      await member.setNickname(nickname, mod.auditReason(i.member, 'Nickname change'));
      await i.reply(ephemeral(nickname ? `✅ ${member} is now **${nickname}**.` : `✅ Reset ${member}'s nickname.`));
    },
  },

  {
    data: command('decancer', 'Make unreadable or invisible names readable', PermissionFlagsBits.ManageNicknames)
      .addUserOption((o) => o.setName('user').setDescription('One member. Leave empty to clean everyone')),
    execute: decancerCommand,
  },
];
