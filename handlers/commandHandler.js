const fs = require('fs');
const path = require('path');
const db = require('../src/utils/db');

let commands = new Map();
const settingsPath = path.join(__dirname, '..', 'settings.json');

const loadCommands = (commandsPath) => {
  const absolutePath = path.resolve(commandsPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Directory ${absolutePath} does not exist.`);
  }

  commands.clear();
  const commandFiles = fs.readdirSync(absolutePath).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(absolutePath, file));
    commands.set(command.name, command);
  }

  console.log(`Loaded ${commands.size} commands from ${absolutePath}`);
};

const loadGlobalCommands = (globalCommandsPath) => {
  const absolutePath = path.resolve(globalCommandsPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Directory ${absolutePath} does not exist.`);
  }

  const commandFiles = fs.readdirSync(absolutePath).filter(file => file.endsWith('.js'));

  for (const file of commandFiles) {
    const command = require(path.join(absolutePath, file));
    commands.set(command.name, command);
  }

  console.log(`Loaded global commands from ${absolutePath}`);
};

const validateCommandsPath = (commandsPath) => {
  const absolutePath = path.resolve(commandsPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Directory ${absolutePath} does not exist.`);
  }

  const commandFiles = fs.readdirSync(absolutePath).filter(file => file.endsWith('.js'));
  return commandFiles.length > 0;
};

const getCommands = () => commands;

const getCurrentCommandPath = () => {
  const settings = loadSettings();
  return settings.commands[0].currentCommandPath || path.join(__dirname, '..', 'commands');
};

const getServerMonitorSettings = () => {
  const settings = loadSettings();
  return settings.serverMonitor[0];
};

const loadSettings = () => {
  if (!fs.existsSync(settingsPath)) {
    const defaultSettings = {
      commands: [
        {
          currentCommandPath: path.join(__dirname, '..', 'commands')
        }
      ],
      serverMonitor: [
        {
          serverDataUrl: 'http://test.com/server-data',
          channelId: '123456789012345678'
        }
      ]
    };
    fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf-8');
    return defaultSettings;
  }
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
};

const saveSettings = (settings) => {
  const currentSettings = loadSettings();
  const newSettings = { ...currentSettings, ...settings };
  fs.writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), 'utf-8');
};

const setCommandPath = (commandsPath) => {
  const absolutePath = path.resolve(commandsPath);
  saveSettings({ commands: [{ currentCommandPath: absolutePath }] });
};

const setServerMonitorSettings = (url, channelId) => {
  saveSettings({ serverMonitor: [{ serverDataUrl: url, channelId: channelId }] });
};

async function handlePlayersCommand(command, message) {
  let query = '';
  if (command === 'players') {
    query = 'SELECT * FROM players WHERE status = "ingame"';
  } else if (command === 'players left') {
    query = 'SELECT * FROM players WHERE status = "left"';
  } else if (command === 'players all') {
    query = 'SELECT * FROM players';
  }

  if (query) {
    db.all(query, (err, rows) => {
      if (err) {
        message.channel.send('An error occurred while fetching the data.');
        console.error(err);
        return;
      }

      if (rows.length === 0) {
        message.channel.send('No players found.');
        return;
      }

      const playerList = rows.map(player => `${player.name} (${player.status})`).join('\n');
      message.channel.send(`Players:\n${playerList}`);
    });
  } else {
    message.channel.send('Invalid command. Use /players, /players left, or /players all.');
  }
}

module.exports = { loadCommands, loadGlobalCommands, getCommands, getCurrentCommandPath, validateCommandsPath, setCommandPath, getServerMonitorSettings, setServerMonitorSettings, handlePlayersCommand };
