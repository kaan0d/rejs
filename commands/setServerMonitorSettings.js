module.exports = {
    name: 'setservermonitor',
    description: 'Set the server monitor URL and channel ID',
    execute(message, args) {
      if (args.length < 2) {
        return message.reply('Please provide both the URL and the channel ID.');
      }
      
      const url = args[0];
      const channelId = args[1];
      const { setServerMonitorSettings } = require('../handlers/commandHandler');
      
      setServerMonitorSettings(url, channelId);
      message.reply(`Server monitor settings updated. URL: ${url}, Channel ID: ${channelId}`);
    }
  };
  