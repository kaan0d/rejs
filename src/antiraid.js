const {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, GuildVerificationLevel,
  PermissionFlagsBits, Events,
} = require('discord.js');
const { getFeature, setFeature, getSettings } = require('./db');
const { ephemeral } = require('./util');
const mod = require('./moderation');
const journal = require('./journal');

const DEFAULTS = { enabled: false, joins: 20, seconds: 60, verification: true, lock: false, kick: false };
const IDLE = { active: false };
const LOCKABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

// guildId -> recent joins [{ at, id }]. Only needs to cover the detection window.
const joins = new Map();

// Sends to the mod log with an @here ping, since a raid needs someone now.
async function alertStaff(guild, embed, components = []) {
  const channel = guild.channels.cache.get(getSettings(guild.id).modlog_channel_id);
  if (channel) {
    await channel.send({ content: '@here', embeds: [embed], components, allowedMentions: { parse: ['everyone'] } }).catch(() => {});
  } else {
    // No mod log: tell the server owner directly.
    await (await guild.fetchOwner().catch(() => null))?.send({ embeds: [embed] }).catch(() => {});
  }
}

async function kickRaiders(guild, ids) {
  let kicked = 0;
  for (const id of ids) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member?.kickable && await member.kick('Anti-raid: joined during a raid').then(() => true, () => false)) kicked++;
  }
  return kicked;
}

async function startRaid(guild, cfg, ids) {
  const everyone = guild.roles.everyone;
  // Save first, so joins arriving while we work don't trigger a second raid.
  const state = { active: true, since: Date.now(), verification: null, locked: [] };
  setFeature(guild.id, 'raid_state', state);

  const done = [];
  if (cfg.verification && guild.verificationLevel < GuildVerificationLevel.VeryHigh) {
    state.verification = guild.verificationLevel;
    if (await guild.setVerificationLevel(GuildVerificationLevel.VeryHigh, 'Anti-raid').then(() => true, () => false)) {
      done.push('Verification level raised to **Highest** (verified phone required)');
    }
  }
  if (cfg.lock) {
    for (const channel of guild.channels.cache.filter((c) => LOCKABLE.includes(c.type)).values()) {
      if (!channel.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages) || !channel.manageable) continue;
      // Remember the old @everyone setting (allow, or neutral) so ending the raid restores it exactly.
      const previous = channel.permissionOverwrites.cache.get(everyone.id)?.allow.has(PermissionFlagsBits.SendMessages) ? true : null;
      if (await channel.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: 'Anti-raid lock' }).then(() => true, () => false)) {
        state.locked.push({ id: channel.id, previous });
      }
    }
    done.push(`Locked **${state.locked.length}** channels`);
  }
  setFeature(guild.id, 'raid_state', state);
  if (cfg.kick) done.push(`Kicked **${await kickRaiders(guild, ids)}** of ${ids.length} accounts that joined`);

  const lines = [`**${ids.length}** accounts joined within ${cfg.seconds} seconds.`, ''];
  lines.push(...(done.length ? done : ['Alert only, nothing was changed']).map((d) => `• ${d}`));
  if (cfg.kick) lines.push('• New joins are kicked until raid mode ends');
  lines.push('', 'End raid mode with the button or `/antiraid end` once it is over.');
  await alertStaff(guild, new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle('🚨 Raid detected')
    .setDescription(lines.join('\n'))
    .setTimestamp(),
  [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`raid-end:${guild.id}`).setLabel('End raid mode').setStyle(ButtonStyle.Success),
  )]);
}

// Puts back everything raid mode changed. Returns a summary.
async function endRaid(guild, moderator) {
  const state = getFeature(guild.id, 'raid_state', IDLE);
  if (!state.active) return null;
  setFeature(guild.id, 'raid_state', IDLE);

  if (state.verification !== null) {
    journal.verificationLevel(guild);
    await guild.setVerificationLevel(state.verification, 'Raid mode ended').catch(() => {});
  }
  let unlocked = 0;
  for (const { id, previous } of state.locked) {
    const channel = guild.channels.cache.get(id);
    if (channel) journal.overwrite(channel, guild.roles.everyone.id);
    if (await channel?.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: previous }, { reason: 'Raid mode ended' }).then(() => true, () => false)) unlocked++;
  }
  const summary = [
    state.verification !== null && 'verification level restored',
    state.locked.length && `${unlocked} channels unlocked`,
  ].filter(Boolean).join(', ') || 'nothing needed restoring';
  await mod.modLog(guild, { title: '✅ Raid mode ended', color: Colors.Green, moderator, extra: `Raid started <t:${Math.floor(state.since / 1000)}:R>; ${summary}.` });
  return summary;
}

async function onJoin(member) {
  const { guild } = member;
  const cfg = getFeature(guild.id, 'antiraid', DEFAULTS);
  if (!cfg.enabled) return;

  if (getFeature(guild.id, 'raid_state', IDLE).active) {
    if (cfg.kick && member.kickable) await member.kick('Anti-raid: joined during a raid').catch(() => {});
    return;
  }
  const now = Date.now();
  const recent = (joins.get(guild.id) ?? []).filter((j) => now - j.at < cfg.seconds * 1000);
  recent.push({ at: now, id: member.id });
  joins.set(guild.id, recent);
  if (recent.length >= cfg.joins) {
    joins.delete(guild.id);
    await startRaid(guild, cfg, recent.map((j) => j.id));
  }
}

const handlers = {
  async 'raid-end'(i) {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply(ephemeral('You need Manage Server to end raid mode.'));
    // Unlocking many channels takes longer than Discord's 3-second reply window.
    await i.deferUpdate();
    const summary = await endRaid(i.guild, i.user);
    await i.editReply({ components: [] });
    await i.followUp(ephemeral(summary ? `✅ Raid mode ended: ${summary}.` : 'Raid mode was already over.'));
  },
};

const register = (client) => client.on(Events.GuildMemberAdd, (m) => onJoin(m).catch((e) => console.error('Anti-raid:', e)));

module.exports = { DEFAULTS, IDLE, register, handlers, endRaid, onJoin };
