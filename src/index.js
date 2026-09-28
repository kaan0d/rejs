const {
  Client, Events, GatewayIntentBits, Partials, MessageFlags, REST, Routes, ApplicationFlagsBitField,
} = require('discord.js');
const monitor = require('./monitor');
const scheduler = require('./scheduler');
const logs = require('./logs');
const appeals = require('./appeals');
const gate = require('./gate');
const antiraid = require('./antiraid');
const antinuke = require('./antinuke');
const antispam = require('./antispam');
const tickets = require('./tickets');
const reports = require('./reports');
const community = require('./community');
const automation = require('./automation');
const giveaways = require('./giveaways');
const tempvoice = require('./tempvoice');
const ops = require('./ops');
const setup = require('./setup');
const journal = require('./journal');
const mod = require('./moderation');
const updater = require('./updater');

// Command files and the /help category each one belongs to.
const FILES = {
  general: '👋 General', info: '👋 General', utility: '👋 General',
  moderation: '🔨 Moderation', cases: '🔨 Moderation', staff: '🔨 Moderation', bulk: '🔨 Moderation',
  protection: '🛡️ Protection', snapshot: '🛡️ Protection', logs: '📜 Logs',
  support: '🎫 Support', community: '🎉 Community', events: '🎉 Community',
  automation: '⚙️ Automation', server: '🎮 Game server', channels: '🔧 Setup', admin: '🔧 Setup', undo: '🔧 Setup', owner: '👑 Owner',
};
const commands = new Map(
  Object.entries(FILES)
    .flatMap(([file, category]) => require(`./commands/${file}`).map((command) => ({ ...command, category })))
    .map((command) => [command.data.name, command]),
);

// Buttons and forms that must keep working after a restart, keyed by the custom ID prefix.
const components = {
  ...appeals.handlers, ...gate.handlers, ...antiraid.handlers, ...tickets.handlers, ...reports.handlers, ...community.handlers,
  ...giveaways.handlers, ...setup.handlers,
};

// Staff buttons whose changes can be undone, with the label shown in /undo.
const STAFF_COMPONENTS = {
  setup: 'Setup wizard',
  'appeal-accept': 'Accepted a ban appeal', 'appeal-deny': 'Denied a ban appeal',
  'report-delete': 'Deleted a reported message', 'report-warn': 'Warned from a report', 'report-timeout': 'Timed out from a report',
  'report-ban': 'Banned from a report', 'report-dismiss': 'Dismissed a report',
  'gate-approve': 'Approved a quarantined member', 'gate-kick': 'Kicked a quarantined member', 'gate-ban': 'Banned a quarantined member',
  'raid-end': 'Ended raid mode',
};

// Set once logged in, so crashes outside an interaction can still be reported.
let activeClient = null;

// Asks Discord which privileged intents are turned on, so a missing Message Content intent
// switches message features off instead of failing to log in.
async function checkIntents(token) {
  const app = await new REST().setToken(token).get(Routes.currentApplication()).catch((e) => {
    throw e.status === 401 ? new Error('DISCORD_TOKEN is invalid. Reset it under Bot in the Discord Developer Portal and update .env.') : e;
  });
  const flags = new ApplicationFlagsBitField(app.flags);
  const F = ApplicationFlagsBitField.Flags;
  if (!flags.any([F.GatewayGuildMembers, F.GatewayGuildMembersLimited])) {
    throw new Error('Turn on "Server Members Intent" under Bot in the Discord Developer Portal, then start again.');
  }
  const messageContent = flags.any([F.GatewayMessageContent, F.GatewayMessageContentLimited]);
  if (!messageContent) console.warn('Message Content intent is off: message logs will show no text and message edits are not logged.');
  return messageContent;
}

async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    if (command?.autocomplete) return command.autocomplete(interaction);
    const focused = interaction.options.getFocused(true);
    return interaction.respond(focused.name === 'reason' ? mod.reasonChoices(interaction.guildId, focused.value) : []);
  }
  if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
    const command = commands.get(interaction.commandName);
    if (command?.owner && !interaction.client.isOwner(interaction.user.id)) {
      return interaction.reply({ content: 'Only the bot owner can use this.', flags: MessageFlags.Ephemeral });
    }
    if (!command) return null;
    ops.countUsage(command.data.name);
    // Staff commands are recorded so /undo can reverse them.
    const permissions = command.data.toJSON().default_member_permissions;
    if (!interaction.inGuild() || !permissions || command.owner || command.noJournal) return command.execute(interaction);
    const label = (interaction.isChatInputCommand() ? interaction.toString() : `${command.data.name}`).slice(0, 100);
    return journal.run({ guildId: interaction.guildId, userId: interaction.user.id, label, permissions }, () => command.execute(interaction));
  }
  if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
    const [name, arg] = interaction.customId.split(':');
    const handler = components[name];
    if (!handler) return null;
    if (!interaction.inGuild() || !STAFF_COMPONENTS[name]) return handler(interaction, arg);
    const label = `${STAFF_COMPONENTS[name]}${name === 'setup' ? `: ${arg}` : ''}`;
    return journal.run({ guildId: interaction.guildId, userId: interaction.user.id, label, permissions: null }, () => handler(interaction, arg));
  }
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is missing. Put it in the .env file.');
  const messageContent = await checkIntents(token);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      // Delivers audit log entries, which anti-nuke uses to see who did what.
      GatewayIntentBits.GuildModeration,
      ...(messageContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    // Lets delete and leave events arrive for messages and members the bot hasn't cached.
    partials: [Partials.Message, Partials.GuildMember],
    // Channel renames are limited to 2 per 10 minutes. Fail fast instead of freezing the caller for minutes.
    rest: { rejectOnRateLimit: (limit) => limit.method.toUpperCase() === 'PATCH' && limit.route.startsWith('/channels') },
  });
  client.commands = commands;
  client.hasMessageContent = messageContent;
  // Replaced once the owner is known; until then nobody counts as the owner.
  client.isOwner = () => false;
  client.notifyOwner = async () => {};

  client.once(Events.ClientReady, async (c) => {
    try {
      // The owner is whoever owns the application in the Developer Portal (or its team members).
      const { owner } = await c.application.fetch();
      c.isOwner = (id) => (owner?.members ? owner.members.has(id) : owner?.id === id);
      c.notifyOwner = (text) => (owner?.members ? owner.owner?.user : owner)?.send(text).catch(() => {});

      // Owner commands go only to the dev server when one is set, so other servers never see them.
      const all = [...commands.values()];
      const devGuild = process.env.DEV_GUILD_ID;
      await c.application.commands.set(all.filter((cmd) => !devGuild || !cmd.owner).map((cmd) => cmd.data));
      if (devGuild) await c.application.commands.set(all.filter((cmd) => cmd.owner).map((cmd) => cmd.data), devGuild);
    } catch (error) {
      // A bad DEV_GUILD_ID or a Discord hiccup must not stop the monitor, scheduler and updater below.
      await ops.reportError(c, 'Registering commands failed', error);
    }
    console.log(`${c.user.tag} is online in ${c.guilds.cache.size} servers with ${commands.size} commands.`);
    monitor.start(c);
    scheduler.start(c);
    tempvoice.cleanup(c).catch((e) => console.error('Temp voice cleanup:', e));
    updater.start(c);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (error) {
      await ops.reportError(interaction.client, `Interaction ${interaction.commandName ?? interaction.customId} failed`, error);
      if (!interaction.isRepliable()) return;
      const reply = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
    }
  });

  for (const feature of [ops, setup, logs, gate, antiraid, antinuke, antispam, tickets, community, automation, tempvoice]) feature.register(client);
  activeClient = client;
  await client.login(token);
}

// A failed Discord call in a button handler should log, not take the bot down.
process.on('unhandledRejection', (error) => ops.reportError(activeClient, 'Unhandled rejection', error));

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
