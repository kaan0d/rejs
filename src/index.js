const { Client, IntentsBitField } = require('discord.js');
const path = require('path');
require('dotenv').config();
const { loadCommands, loadGlobalCommands, getCommands, getCurrentCommandPath } = require('../handlers/commandHandler');
const { checkServerUpdates } = require('./utils/serverMonitor');

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(
    `${client.user.tag}\n${client.user.id}\n${client.guilds.cache.size} servers`
  );
  checkServerUpdates(client);
});

client.on('messageCreate', (message) => {
    if (!message.content.startsWith('!') || message.author.bot) return;
  
    const args = message.content.slice(1).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
  
    const commands = getCommands();
    const command = commands.get(commandName);
  
    if (!command) return;
  
    try {
      command.execute(message, args);
    } catch (error) {
      console.error(error);
      message.reply('There was an error executing that command.');
    }
  });

try {
    const currentCommandPath = getCurrentCommandPath();
    loadCommands(currentCommandPath);
    loadGlobalCommands(path.join(__dirname, '..', 'global-commands'));
  } catch (error) {
    console.error(`Failed to load commands: ${error.message}`);
  }

client.login(process.env.DISCORD_TOKEN);
