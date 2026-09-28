const {
  Client, Events, GatewayIntentBits, Partials, MessageFlags, REST, Routes, ApplicationFlagsBitField,
} = require('discord.js');
const { getSettings } = require('./db');
const monitor = require('./monitor');
const scheduler = require('./scheduler');
const logs = require('./logs');
const appeals = require('./appeals');
const mod = require('./moderation');
const updater = require('./updater');

const commands = new Map(
  ['general', 'info', 'moderation', 'cases', 'staff', 'bulk', 'logs', 'automation', 'server', 'admin', 'owner']
    .flatMap((file) => require(`./commands/${file}`))
    .map((command) => [command.data.name, command]),
);

// Buttons and forms that must keep working after a restart, keyed by the custom ID prefix.
const components = { ...appeals.handlers };

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
    const focused = interaction.options.getFocused(true);
    return interaction.respond(focused.name === 'reason' ? mod.reasonChoices(interaction.guildId, focused.value) : []);
  }
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName);
    if (command?.owner && !interaction.client.isOwner(interaction.user.id)) {
      return interaction.reply({ content: 'Only the bot owner can use this.', flags: MessageFlags.Ephemeral });
    }
    return command?.execute(interaction);
  }
  if (interaction.isButton() || interaction.isModalSubmit()) {
    const [name, arg] = interaction.customId.split(':');
    return components[name]?.(interaction, arg);
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
      ...(messageContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    // Lets delete and leave events arrive for messages and members the bot hasn't cached.
    partials: [Partials.Message, Partials.GuildMember],
  });
  client.commands = commands;
  client.hasMessageContent = messageContent;

  client.once(Events.ClientReady, async (c) => {
    // The owner is whoever owns the application in the Developer Portal (or its team members).
    const { owner } = await c.application.fetch();
    c.isOwner = (id) => (owner?.members ? owner.members.has(id) : owner?.id === id);
    c.notifyOwner = (text) => (owner?.members ? owner.owner?.user : owner)?.send(text).catch(() => {});

    // Owner commands go only to the dev server when one is set, so other servers never see them.
    const all = [...commands.values()];
    const devGuild = process.env.DEV_GUILD_ID;
    await c.application.commands.set(all.filter((cmd) => !devGuild || !cmd.owner).map((cmd) => cmd.data));
    if (devGuild) await c.application.commands.set(all.filter((cmd) => cmd.owner).map((cmd) => cmd.data), devGuild);
    console.log(`${c.user.tag} is online in ${c.guilds.cache.size} servers with ${commands.size} commands.`);
    monitor.start(c);
    scheduler.start(c);
    updater.start(c);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (error) {
      console.error(`Interaction ${interaction.commandName ?? interaction.customId} failed:`, error);
      if (!interaction.isRepliable()) return;
      const reply = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
    }
  });

  // Members still on the rules screen get the role once they accept.
  async function giveAutoRole(member) {
    const { autorole_id } = getSettings(member.guild.id);
    if (!autorole_id || member.user.bot || member.pending) return;
    await member.roles.add(autorole_id, 'Auto-role').catch((e) => console.error(`Auto-role in ${member.guild.id}: ${e.message}`));
  }
  client.on(Events.GuildMemberAdd, giveAutoRole);
  client.on(Events.GuildMemberUpdate, (before, after) => !before.partial && before.pending && !after.pending && giveAutoRole(after));

  logs.register(client);
  await client.login(token);
}

// A failed Discord call in a button handler should log, not take the bot down.
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
