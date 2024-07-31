const { getServerMonitorSettings } = require("../../handlers/commandHandler");
const db = require("./db");
const moment = require("moment");
const { initializeDatabase } = require("./backupAndClear");

let isInitialized = false;
let retryCount = 0;
let delayCount = 0;
let updateInterval;

async function fetchServerData() {
  try {
    const settings = getServerMonitorSettings();
    const fetch = (await import("node-fetch")).default;
    const response = await fetch(settings.serverPlayersUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Failed to fetch server data:", error);
    return null;
  }
}

async function updateDatabase(currentData) {
  const currentDate = moment().unix();

  currentData.forEach((player) => {
    const steamIdentifier = player.identifiers.find((id) =>
      id.startsWith("steam:")
    );
    const discordIdentifier = player.identifiers.find((id) =>
      id.startsWith("discord:")
    );

    db.run(
      `
      INSERT OR IGNORE INTO players (id, name, steam, discord, join_date, status)
      VALUES (?, ?, ?, ?, ?, 'ingame')
    `,
      [player.id, player.name, steamIdentifier, discordIdentifier, currentDate]
    );

    db.run(
      `
      UPDATE players
      SET name = ?, steam = ?, discord = ?, status = 'ingame', join_date = COALESCE(join_date, ?)
      WHERE id = ?
    `,
      [player.name, steamIdentifier, discordIdentifier, currentDate, player.id]
    );
  });
}

async function updateStatusToLeft(previousData, currentIds) {
  const currentDate = moment().unix();

  previousData.forEach((player) => {
    if (!currentIds.has(player.id)) {
      db.run(
        `
        UPDATE players
        SET status = 'left', leave_date = ?
        WHERE id = ?
      `,
        [currentDate, player.id]
      );
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

function isServerRestartTime() {
  const currentTime = moment();

  const restartWindows = [
    { start: "17:00", end: "17:10" },
    { start: "06:00", end: "06:10" },
  ];

  return restartWindows.some((window) => {
    const start = moment(window.start, "HH:mm");
    const end = moment(window.end, "HH:mm");

    return currentTime.isBetween(start, end);
  });
}

async function checkServerUpdates(client) {
  if (!isInitialized) {
    await initializeDatabase();
    isInitialized = true;

    const settings = getServerMonitorSettings();
    const channel = client.channels.cache.get(settings.channelId);

    const startMessage = "Logging has started. Monitoring server activity...";

    if (channel) channel.send(startMessage);
    const initialData = await fetchServerData();
    if (initialData) {
      await updateDatabase(initialData);
    }
  }

  try {
    const currentData = await fetchServerData();
    if (!currentData) {
      throw new Error("No data received");
    }

    const previousData = await getPreviousDataFromDatabase();
    const currentIds = new Set(currentData.map((player) => player.id));
    const previousIds = new Set(previousData.map((player) => player.id));

    const settings = getServerMonitorSettings();
    const channel = client.channels.cache.get(settings.channelId);

    const joined = currentData.filter((player) => !previousIds.has(player.id));
    const left = previousData.filter((player) => !currentIds.has(player.id));

    await updateDatabase(currentData);
    await updateStatusToLeft(previousData, currentIds);

    if (joined.length > 0) {
      const joinMessage = joined
        .map((player) => `🟩 ${player.name} joined the server.`)
        .join("\n");
      if (channel) channel.send(joinMessage);
    }

    if (left.length > 0) {
      const leftMessage = left
        .map((player) => `🟥 ${player.name} left the server.`)
        .join("\n");
      if (channel) channel.send(leftMessage);
    }

    try {
      const playersCount = await fetch(settings.serverDynamicUrl);
      const countData = await playersCount.json();

      client.user.setPresence({
        activities: [
          {
            name: `${countData.clients}/${countData.sv_maxclients} players`,
          },
        ],
      });
    } catch (error) {
      console.error("Failed to fetch server dynamic data:", error);
    }

    retryCount = 0;
    delayCount = 0;

    updateInterval = setTimeout(() => checkServerUpdates(client), 1000);

  } catch (error) {
    console.error("Error during checkServerUpdates:", error);

    retryCount++;

    if (isServerRestartTime() || retryCount >= 5) {
      delayCount++;

      if (delayCount >= 3) {
        console.log(
          "Failed to fetch server data multiple times, aborting the check."
        );
        clearTimeout(updateInterval);
        return;
      }

      console.log(
        `Failed to fetch server data ${retryCount} times, delaying the check by 10 minutes.`
      );
      setTimeout(() => checkServerUpdates(client), 600000);
    } else {
      console.log(
        "Failed to fetch server data, delaying the check by 30 seconds."
      );
      setTimeout(() => checkServerUpdates(client), 30000);
    }
  }
}

module.exports = { checkServerUpdates };
