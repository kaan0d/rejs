// The setup wizard: posted when the bot joins a server, and again with /setup.
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, AuditLogEvent, Events,
} = require('discord.js');
const { getSettings, setSetting, getFeature, setFeature } = require('./db');
const { BRAND, ephemeral } = require('./util');
const gate = require('./gate');
const tickets = require('./tickets');
const { isBlacklisted } = require('./ops');
const journal = require('./journal');

const P = PermissionFlagsBits;
const LOG_CHANNELS = [
  ['mod-log', (g, id) => setSetting(g, 'modlog_channel_id', id)],
  ['message-log', (g, id) => setSetting(g, 'message_log_id', id)],
  ['member-log', (g, id) => setSetting(g, 'member_log_id', id)],
  ['voice-log', (g, id) => setSetting(g, 'voice_log_id', id)],
  ['reports', (g, id) => setFeature(g, 'reports', { channelId: id })],
  ['appeals', (g, id) => setSetting(g, 'appeals_channel_id', id)],
  ['ticket-log', (g, id) => setFeature(g, 'tickets', { ...tickets.settings(g), logChannelId: id })],
];

// A private staff category with every log channel, wired into the settings.
async function createLogs(guild) {
  const me = guild.members.me;
  const category = await guild.channels.create({
    name: 'Staff logs',
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
      { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles] },
    ],
    reason: 'Setup wizard',
  });
  journal.created('channel', category);
  for (const [name, save] of LOG_CHANNELS) {
    const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, reason: 'Setup wizard' });
    journal.created('channel', channel);
    save(guild.id, channel.id);
  }
  return `Created ${category} with ${LOG_CHANNELS.length} channels. Only admins can see it; give your moderator role access to the category.`;
}

async function createVerify(guild) {
  const role = await guild.roles.create({ name: 'Verified', reason: 'Setup wizard' });
  journal.created('role', role);
  const channel = await guild.channels.create({
    name: 'verify',
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
      { id: guild.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks] },
    ],
    reason: 'Setup wizard',
  });
  journal.created('channel', channel);
  await gate.postVerifyPanel(channel, role);
  return `Created ${role} and ${channel} with a Verify button. To make it required, hide your other channels from @everyone and show them to ${role}.`;
}

async function createQuarantine(guild) {
  setFeature(guild.id, 'agegate', { ...getFeature(guild.id, 'agegate', gate.AGE_DEFAULTS), enabled: true, minAgeMs: 7 * 86_400_000 });
  const { role, channel } = await gate.setupQuarantine(guild);
  return `Accounts younger than 7 days now get ${role} and only see ${channel}. Change the age with \`/agegate set\`.`;
}

const STEPS = {
  logs: { label: 'Create log channels', run: createLogs, done: (g) => Boolean(getSettings(g).modlog_channel_id) },
  verify: { label: 'Create verification', run: createVerify, done: (g) => Boolean(getFeature(g, 'verification', {}).roleId) },
  quarantine: { label: 'Quarantine new accounts', run: createQuarantine, done: (g) => getFeature(g, 'agegate', {}).enabled },
};

function wizardMessage(guild) {
  const lines = Object.values(STEPS).map((s) => `${s.done(guild.id) ? '✓' : '○'} ${s.label}${s.done(guild.id) ? ' · done' : ''}`);
  return {
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle(`Thanks for adding ${guild.members.me.user.username}!`)
      .setDescription([
        'A few clicks set up the basics. Each button creates what it needs and connects it to the bot.',
        '', ...lines, '',
        'After that: `/protection` for raids, nukes and spam, `/automod` for word filters, and `/help` for everything else.',
      ].join('\n'))],
    components: [new ActionRowBuilder().addComponents(
      ...Object.entries(STEPS).map(([key, s]) => new ButtonBuilder().setCustomId(`setup:${key}`).setLabel(s.label)
        .setStyle(s.done(guild.id) ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(s.done(guild.id))),
      new ButtonBuilder().setCustomId('setup:done').setLabel('Done').setStyle(ButtonStyle.Success),
    )],
  };
}

const handlers = {
  async setup(i, step) {
    if (!i.memberPermissions?.has(P.ManageGuild)) return i.reply(ephemeral('You need Manage Server to run the setup.'));
    if (step === 'done') return i.update({ components: [] });
    if (!i.guild.members.me.permissions.has([P.ManageChannels, P.ManageRoles])) {
      return i.reply(ephemeral('I need Manage Channels and Manage Roles for the setup.'));
    }
    // Creating channels can take longer than Discord's 3-second reply window.
    await i.deferUpdate();
    const result = await STEPS[step].run(i.guild).catch((e) => `❌ ${e.message}`);
    await i.editReply(wizardMessage(i.guild));
    await i.followUp(ephemeral(result.startsWith('❌') ? result : `✅ ${result}`));
  },
};

// Posts the wizard in the server and tells whoever added the bot where to find it.
async function welcomeServer(guild) {
  const me = guild.members.me;
  const canPost = (c) => c?.isTextBased() && c.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
  const channel = [guild.systemChannel, ...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).sort((a, b) => a.position - b.position).values()]
    .find(canPost);
  const message = await channel?.send(wizardMessage(guild)).catch(() => null);

  const entry = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
  const adder = entry?.entries.find((e) => e.targetId === me.id)?.executor;
  await adder?.send(message
    ? `Thanks for adding me to **${guild.name}**! I posted a quick setup in ${message.url}. You can bring it back any time with \`/setup\`.`
    : `Thanks for adding me to **${guild.name}**! Run \`/setup\` there to get started.`).catch(() => {});
}

const register = (client) => client.on(Events.GuildCreate, (guild) => {
  if (!guild.members.me || isBlacklisted(guild.id)) return;
  welcomeServer(guild).catch((e) => console.error('Setup wizard:', e));
});

module.exports = { wizardMessage, handlers, register };
