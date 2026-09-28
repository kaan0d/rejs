const { Client, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const levels = require('./levels');
const monitor = require('./monitor');

const commands = new Map(
  ['general', 'levels', 'server', 'admin']
    .flatMap((file) => require(`./commands/${file}`))
    .map((command) => [command.data.name, command]),
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged: turn on "Message Content Intent" in the Developer Portal. Needed to spot "thanks".
    GatewayIntentBits.MessageContent,
  ],
});
client.commands = commands;

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([...commands.values()].map((command) => command.data));
  console.log(`${c.user.tag} is online in ${c.guilds.cache.size} servers with ${commands.size} commands.`);
  monitor.start(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await commands.get(interaction.commandName)?.execute(interaction);
  } catch (error) {
    console.error(`/${interaction.commandName} failed:`, error);
    const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
  }
});

client.on(Events.MessageCreate, (message) => levels.onMessage(message).catch(console.error));

// A failed Discord call in a button handler should log, not take the bot down.
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(process.env.DISCORD_TOKEN);
