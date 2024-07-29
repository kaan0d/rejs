module.exports = {
  name: 'setservermonitor',
  description: 'Set the server monitor IP, optional port, and channel ID',
  async execute(message, args) {
    if (args.length < 2) {
      return message.reply('Please provide the IP address and the channel ID.');
    }

    let ip;
    let port = 30120;
    let channelId;

    if (args.length === 2) {
      [ip, channelId] = args;
    } else if (args.length === 3) {
      [ip, port, channelId] = args;
    } else {
      return message.reply('Invalid number of arguments. Please provide the IP address, optional port, and channel ID.');
    }

    const playersUrl = `http://${ip}:${port}/players.json`;
    const dynamicUrl = `http://${ip}:${port}/dynamic.json`;

    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(playersUrl);
      if (!response.ok) {
        return message.reply('Failed to fetch data from the provided IP address.');
      }
      const data = await response.json();
      if (!Array.isArray(data)) {
        return message.reply('The provided IP address does not return valid JSON data.');
      }
    } catch (error) {
      console.error('Error validating server monitor settings:', error);
      return message.reply('An error occurred while validating the IP address.');
    }

    const { setServerMonitorSettings } = require('../handlers/commandHandler');
    setServerMonitorSettings(playersUrl, dynamicUrl, channelId);
    message.reply(`Server monitor settings updated.\nPlayers URL: ${playersUrl}\nDynamic URL: ${dynamicUrl}\nChannel ID: ${channelId}`);
  }
};
