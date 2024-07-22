const { getServerMonitorSettings } = require('../../handlers/commandHandler');

let previousData = [];

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

async function checkServerUpdates(client) {
  const startTime = Date.now();
  const currentData = await fetchServerData();
  if (!currentData) return;

  const currentIds = new Set(currentData.map(player => player.id));
  const previousIds = new Set(previousData.map(player => player.id));

  const joined = currentData.filter(player => !previousIds.has(player.id));
  const left = previousData.filter(player => !currentIds.has(player.id));

  const settings = getServerMonitorSettings();
  const channel = client.channels.cache.get(settings.channelId);

  if (joined.length > 0) {
    const joinMessage = joined.map(player => `🟩 ${player.name} joined the server.`).join('\n');
    // console.log(joinMessage);
    if (channel) channel.send(joinMessage);
  }

  if (left.length > 0) {
    const leftMessage = left.map(player => `🟥 ${player.name} left the server.`).join('\n');
    // console.log(leftMessage);
    if (channel) channel.send(leftMessage);
  }

  previousData = currentData;
}

module.exports = { checkServerUpdates };
