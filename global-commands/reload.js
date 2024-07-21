const { loadCommands, getCurrentCommandPath, validateCommandsPath, setCommandPath } = require('../handlers/commandHandler');
const path = require('path');

module.exports = {
  name: 'reload',
  execute(message, args) {
    if (args.length === 0) {
      return message.reply('Please specify the commands path to reload.');
    }

    const basePath = path.dirname(getCurrentCommandPath());
    const commandsPath = path.join(basePath, args[0]);

    try {
      if (validateCommandsPath(commandsPath)) {
        loadCommands(commandsPath);
        setCommandPath(commandsPath);
        message.reply(`Commands reloaded from ${args[0]}`);
      } else {
        message.reply(`\`\`\`The directory ${args[0]} does not contain any valid commands.\`\`\``);
      }
    } catch (error) {
      console.error(error);
      const relativePath = path.relative(basePath, commandsPath);
      message.reply(`\`\`\`There was an error reloading the commands.\nDirectory ${relativePath} does not exist.\`\`\``);
    }
  },
};
