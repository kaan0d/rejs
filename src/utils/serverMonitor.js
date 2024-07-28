const { getServerMonitorSettings } = require('../../handlers/commandHandler');
const db = require('./db');
const moment = require('moment'); // Zaman damgası için moment.js kullanabilirsiniz, npm install moment ile kurun.
const { initializeDatabase, clearDatabase } = require('./backupAndClear');

let isInitialized = false;

async function fetchServerData() {
  try {
    const settings = getServerMonitorSettings();
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(settings.serverDataUrl);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to fetch server data:', error);
    return null;
  }
}

async function updateDatabase(currentData) {
  const currentDate = moment().format('YYYY-MM-DD HH:mm:ss');

  currentData.forEach(player => {
    const steamIdentifier = player.identifiers.find(id => id.startsWith('steam:'));
    const discordIdentifier = player.identifiers.find(id => id.startsWith('discord:'));

    db.run(`
      INSERT OR IGNORE INTO players (id, name, steam, discord, join_date, status)
      VALUES (?, ?, ?, ?, ?, 'ingame')
    `, [player.id, player.name, steamIdentifier, discordIdentifier, currentDate]);

    db.run(`
      UPDATE players
      SET name = ?, steam = ?, discord = ?, status = 'ingame', join_date = COALESCE(join_date, ?)
      WHERE id = ?
    `, [player.name, steamIdentifier, discordIdentifier, currentDate, player.id]);
  });
}

async function updateStatusToLeft(previousData, currentIds) {
  const currentDate = moment().format('YYYY-MM-DD HH:mm:ss');

  previousData.forEach(player => {
    if (!currentIds.has(player.id)) {
      db.run(`
        UPDATE players
        SET status = 'left', leave_date = ?
        WHERE id = ?
      `, [currentDate, player.id]);
    }
  });
}

async function getPreviousDataFromDatabase() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM players WHERE status = "ingame"', (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function checkServerUpdates(client) {
  if (!isInitialized) {
    await initializeDatabase(); // Veritabanını yedekle ve temizle
    isInitialized = true;
    const settings = getServerMonitorSettings();
    const channel = client.channels.cache.get(settings.channelId);
    const startMessage = "Logging has started. Monitoring server activity...";
    if (channel) channel.send(startMessage);
    const currentData = await fetchServerData();
    await updateDatabase(currentData);
  }

  const currentData = await fetchServerData();
  if (!currentData) return;

  const previousData = await getPreviousDataFromDatabase();
  const currentIds = new Set(currentData.map(player => player.id));
  const previousIds = new Set(previousData.map(player => player.id));

  const settings = getServerMonitorSettings();
  const channel = client.channels.cache.get(settings.channelId);

  const joined = currentData.filter(player => !previousIds.has(player.id));
  const left = previousData.filter(player => !currentIds.has(player.id));

  await updateDatabase(currentData);
  await updateStatusToLeft(previousData, currentIds);

  if (joined.length > 0) {
    const joinMessage = joined.map(player => `🟩 ${player.name} joined the server.`).join('\n');
    if (channel) channel.send(joinMessage);
  }

  if (left.length > 0) {
    const leftMessage = left.map(player => `🟥 ${player.name} left the server.`).join('\n');
    if (channel) channel.send(leftMessage);
  }
}

module.exports = { checkServerUpdates };
