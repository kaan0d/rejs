# rejs

**rejs** is a versatile Discord bot built with Node.js and discord.js, designed primarily for monitoring game server activity. It tracks player connections, logs events to a database, and provides real-time updates in a designated Discord channel.

## Features

-   **Game Server Monitoring**: Periodically fetches player data from a server's JSON endpoint (e.g., a FiveM server) to track who is online.
-   **Live Join/Leave Notifications**: Posts messages in a configured channel when players join or leave the server.
-   **Dynamic Bot Presence**: Sets the bot's activity to display the current player count (e.g., "64/128 players").
-   **Persistent Player Database**: Uses SQLite to store a history of player activity, including names, identifiers, and join/leave timestamps.
-   **Data Management**: Automatically backs up the player database and clears it during specified server restart windows to maintain fresh logs.
-   **Dynamic Command Handler**: Load, unload, and reload command modules without restarting the bot.
-   **Administrative Commands**: Includes utilities for message purging and easy configuration directly from Discord.

## Setup and Installation

1.  **Clone the repository:**
    ```sh
    git clone https://github.com/kaan0d/rejs.git
    cd rejs
    ```

2.  **Install dependencies:**
    ```sh
    npm install
    ```

3.  **Create an environment file:**
    Create a `.env` file in the root directory and add your Discord bot token:
    ```env
    DISCORD_TOKEN=your_discord_bot_token_here
    ```

4.  **Run the bot:**
    ```sh
    node src/index.js
    ```

## Configuration

To begin monitoring your game server, you must configure the bot using the `!setservermonitor` command. This command tells the bot where to find your server's player data and which channel to post updates in.

The bot expects the server to expose player data at a `/players.json` endpoint and server metadata at a `/dynamic.json` endpoint, which is standard for FiveM servers.

**Usage:**
```
!setservermonitor <ip> [port] <channelId>
```
-   `<ip>`: Your game server's IP address.
-   `[port]`: Your game server's port. Defaults to `30120` if not provided.
-   `<channelId>`: The ID of the Discord channel where updates will be sent.

**Example:**
```
!setservermonitor 127.0.0.1 30120 123456789012345678
```

## Commands

All commands are prefixed with `!`.

| Command                                        | Description                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `!ping`                                        | Responds with "Pong!" to check if the bot is responsive.                                                      |
| `!players [ingame\|left\|all\|clients]`         | Displays a list of players from the database based on their status. Defaults to `ingame`.                       |
| `!purge <amount>`                              | Deletes a specified number of messages (1-100) from the current channel. Requires "Manage Messages" permission. |
| `!setservermonitor <ip> [port] <channelId>`    | Sets the IP, optional port, and channel ID for the server monitor.                                            |
| `!reload <directory>`                          | Dynamically reloads commands from a specified directory (e.g., `!reload commands`).                           |

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
