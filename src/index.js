const { Client, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { getSettings } = require('./db');
const monitor = require('./monitor');
const scheduler = require('./scheduler');

const commands = new Map(
  ['general', 'server', 'moderation', 'bulk', 'automation', 'admin']
    .flatMap((file) => require(`./commands/${file}`))
    .map((command) => [command.data.name, command]),
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // Privileged: turn on "Server Members Intent" under Bot in the Developer Portal.
    // Needed for auto-role and /bulk role.
    GatewayIntentBits.GuildMembers,
  ],
});
client.commands = commands;

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set([...commands.values()].map((command) => command.data));
  console.log(`${c.user.tag} is online in ${c.guilds.cache.size} servers with ${commands.size} commands.`);
  monitor.start(c);
  scheduler.start(c);
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

// Members still on the rules screen get the role once they accept.
async function giveAutoRole(member) {
  const { autorole_id } = getSettings(member.guild.id);
  if (!autorole_id || member.user.bot || member.pending) return;
  await member.roles.add(autorole_id, 'Auto-role').catch((e) => console.error(`Auto-role in ${member.guild.id}: ${e.message}`));
}
client.on(Events.GuildMemberAdd, giveAutoRole);
client.on(Events.GuildMemberUpdate, (before, after) => before.pending && !after.pending && giveAutoRole(after));

// A failed Discord call in a button handler should log, not take the bot down.
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(process.env.DISCORD_TOKEN);
