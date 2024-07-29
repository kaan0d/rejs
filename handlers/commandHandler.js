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
          serverPlayersUrl: 'http://example.com:30120/players.json',
          serverDynamicUrl: 'http://example.com:30120/dynamic.json',
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

const setServerMonitorSettings = (playersUrl, dynamicUrl, channelId) => {
  saveSettings({
    serverMonitor: [
      {
        serverPlayersUrl: playersUrl,
        serverDynamicUrl: dynamicUrl,
        channelId: channelId
      }
    ]
  });
};

module.exports = {
  loadCommands,
  loadGlobalCommands,
  getCommands,
  getCurrentCommandPath,
  validateCommandsPath,
  setCommandPath,
  getServerMonitorSettings,
  setServerMonitorSettings
};
