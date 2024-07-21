const fs = require('fs');
const path = require('path');

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
  return settings.currentCommandPath || path.join(__dirname, '..', 'commands');
};

const loadSettings = () => {
  if (!fs.existsSync(settingsPath)) {
    return {};
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
  saveSettings({ currentCommandPath: absolutePath });
};

module.exports = { loadCommands, loadGlobalCommands, getCommands, getCurrentCommandPath, validateCommandsPath, setCommandPath };
