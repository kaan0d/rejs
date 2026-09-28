const {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, Events,
} = require('discord.js');
const { getFeature, setFeature, getSettings } = require('./db');
const { BRAND, ephemeral } = require('./util');
const { formatDuration } = require('./monitor');
const mod = require('./moderation');
const ui = require('./ui');
const journal = require('./journal');

const AGE_DEFAULTS = { enabled: false, minAgeMs: 7 * 86_400_000, roleId: null, channelId: null };
const P = PermissionFlagsBits;
const unix = (ms) => Math.floor(ms / 1000);

const ageGate = (guildId) => getFeature(guildId, 'agegate', AGE_DEFAULTS);
const shouldQuarantine = (member) => {
  const cfg = ageGate(member.guild.id);
  return cfg.enabled && !member.user.bot && Date.now() - member.user.createdTimestamp < cfg.minAgeMs;
};

// Creates the Quarantine role and channel if missing, and hides every other channel from the role.
async function setupQuarantine(guild) {
  const cfg = ageGate(guild.id);
  let role = guild.roles.cache.get(cfg.roleId);
  if (!role) {
    role = await guild.roles.create({ name: 'Quarantine', permissions: [], reason: 'Age gate' });
    journal.created('role', role);
  }
  let channel = guild.channels.cache.get(cfg.channelId);
  if (!channel) {
    channel = await guild.channels.create({
      name: 'quarantine',
      type: ChannelType.GuildText,
      topic: 'New accounts wait here until staff approve them.',
      reason: 'Age gate',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: role.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
        { id: guild.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
      ],
    });
    journal.created('channel', channel);
  }
  for (const c of guild.channels.cache.values()) {
    if (c.id === channel.id || c.isThread() || !c.manageable) continue;
    journal.overwrite(c, role.id);
    await c.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'Age gate' }).catch(() => {});
  }
  setFeature(guild.id, 'agegate', { ...cfg, roleId: role.id, channelId: channel.id });
  return { role, channel };
}

async function giveAutoRole(member) {
  const { autorole_id } = getSettings(member.guild.id);
  if (!autorole_id || member.user.bot || member.pending) return;
  await member.roles.add(autorole_id, 'Auto-role')
    .then(() => journal.memberRole(member, autorole_id, true))
    .catch((e) => console.error(`Auto-role in ${member.guild.id}: ${e.message}`));
}

async function quarantine(member) {
  const cfg = ageGate(member.guild.id);
  const role = member.guild.roles.cache.get(cfg.roleId);
  if (!role) return;
  await member.roles.add(role, 'Age gate: account too new').catch(() => {});
  const age = formatDuration(Date.now() - member.user.createdTimestamp);
  await mod.notify(member.user, `👋 Welcome to **${member.guild.name}**! Your account is only ${age} old, so staff will check it before you get full access. You can talk to them in the quarantine channel.`);
  await member.guild.channels.cache.get(cfg.channelId)?.send(`👋 ${member}, your account is new, so staff will review it shortly. Thanks for your patience.`).catch(() => {});

  const channel = member.guild.channels.cache.get(getSettings(member.guild.id).modlog_channel_id);
  await channel?.send({
    embeds: [new EmbedBuilder()
      .setColor(Colors.Orange)
      .setAuthor({ name: `🛂 Quarantined · ${member.user.tag}`, iconURL: member.displayAvatarURL() })
      .setDescription(`${member} (\`${member.id}\`)\nAccount created <t:${unix(member.user.createdTimestamp)}:R>, below the ${formatDuration(cfg.minAgeMs)} minimum.`)
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gate-approve:${member.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gate-kick:${member.id}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gate-ban:${member.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
    )],
    allowedMentions: { parse: [] },
  }).catch(() => {});
}

// Lifts quarantine and hands out the normal join role. Returns false when they weren't quarantined.
async function approve(member, moderator) {
  const { roleId } = ageGate(member.guild.id);
  if (!roleId || !member.roles.cache.has(roleId)) return false;
  await member.roles.remove(roleId, mod.auditReason(moderator, 'Age gate: approved'));
  journal.memberRole(member, roleId, false);
  await giveAutoRole(member);
  await mod.notify(member.user, `✅ Staff approved your account in **${member.guild.name}**. You now have full access.`);
  await mod.modLog(member.guild, { title: '🛂 Approved', color: Colors.Green, target: member.user, moderator });
  return true;
}

async function onJoin(member) {
  if (shouldQuarantine(member)) return quarantine(member);
  return giveAutoRole(member);
}

// Posts the verification panel. Clicking it gives the verified role.
async function postVerifyPanel(channel, role, text) {
  const message = await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('✅ Verification')
      .setDescription(text || `Click the button below to get ${role} and unlock the server.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { parse: [] },
  });
  journal.created('message', message);
  setFeature(channel.guildId, 'verification', { roleId: role.id, channelId: channel.id, messageId: message.id });
  return message;
}

// Buttons on quarantine alerts: each needs the matching permission.
function gateButton(permission, action) {
  return async (i, userId) => {
    if (!i.memberPermissions?.has(permission)) return i.reply(ephemeral("You don't have permission to do that."));
    // Kicking, banning and DMing can take longer than Discord's 3-second reply window.
    await i.deferUpdate();
    const member = await i.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      await i.editReply({ components: [] });
      return i.followUp(ephemeral('They already left the server.'));
    }
    const result = await action(i, member);
    if (!result) return;
    await i.editReply(ui.finishCard(i.message, { status: `${result} by ${i.user.tag}`, color: result === 'Approved' ? Colors.Green : Colors.Red }));
  };
}

const handlers = {
  async verify(i) {
    const { roleId } = getFeature(i.guildId, 'verification', {});
    const role = i.guild.roles.cache.get(roleId);
    if (!role) return i.reply(ephemeral('Verification is not set up anymore. Please tell the staff.'));
    const { roleId: quarantineRole } = ageGate(i.guildId);
    if (quarantineRole && i.member.roles.cache.has(quarantineRole)) return i.reply(ephemeral('Your account is waiting for staff approval first.'));
    if (i.member.roles.cache.has(role.id)) return i.reply(ephemeral("You're already verified."));
    await i.member.roles.add(role, 'Verified with the button');
    await i.reply(ephemeral(`✅ You're verified. Welcome to **${i.guild.name}**!`));
  },

  'gate-approve': gateButton(P.ModerateMembers, async (i, member) => {
    if (!(await approve(member, i.member))) {
      await i.followUp(ephemeral(`${member} isn't in quarantine anymore.`));
      return null;
    }
    return 'Approved';
  }),

  'gate-kick': gateButton(P.KickMembers, async (i, member) => {
    const error = mod.checkTarget(i.member, member, 'kick');
    if (error) { await i.followUp(ephemeral(error)); return null; }
    journal.cannotUndo('Kick (they have to rejoin themselves)');
    await member.kick(mod.auditReason(i.member, 'Age gate: rejected'));
    await mod.recordCase(i.guild, { action: 'kick', user: member.user, moderator: i.user, reason: 'Age gate: rejected' });
    return 'Kicked';
  }),

  'gate-ban': gateButton(P.BanMembers, async (i, member) => {
    const error = mod.checkTarget(i.member, member, 'ban');
    if (error) { await i.followUp(ephemeral(error)); return null; }
    await i.guild.bans.create(member.id, { reason: mod.auditReason(i.member, 'Age gate: rejected') });
    journal.banned(member.id);
    await mod.recordCase(i.guild, { action: 'ban', user: member.user, moderator: i.user, reason: 'Age gate: rejected' });
    return 'Banned';
  }),
};

function register(client) {
  client.on(Events.GuildMemberAdd, (m) => onJoin(m).catch((e) => console.error('Join gate:', e)));
  // Members still on the rules screen get the join role once they accept.
  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (!before.partial && before.pending && !after.pending && !shouldQuarantine(after)) giveAutoRole(after);
  });
  // Keep new channels hidden from quarantined members.
  client.on(Events.ChannelCreate, async (channel) => {
    const { enabled, roleId } = ageGate(channel.guildId);
    // Channels that already mention the role (like the quarantine channel itself) are left alone.
    if (enabled && roleId && !channel.isThread() && !channel.permissionOverwrites?.cache.has(roleId)) {
      await channel.permissionOverwrites?.edit(roleId, { ViewChannel: false }, { reason: 'Age gate' }).catch(() => {});
    }
  });
}

module.exports = { AGE_DEFAULTS, register, handlers, setupQuarantine, approve, postVerifyPanel, shouldQuarantine };
