const db = require('../src/utils/db');

module.exports = {
  name: 'players',
  description: 'Displays a list of players based on their status',
  async execute(message, args) {
    let query = '';

    if (args.length === 0 || args[0] === 'ingame') {
      query = 'SELECT * FROM players WHERE status = "ingame"';
    } else if (args[0] === 'left') {
      query = 'SELECT * FROM players WHERE status = "left"';
    } else if (args[0] === 'all') {
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
      message.channel.send('Invalid command. Use /players, /players ingame, /players left, or /players all.');
    }
  },
};
