# rejs

**rejs** is a Discord bot for game communities. It combines two bots that used to be separate:

- **FiveM server monitor** (the original rejs): posts joins and leaves, shows live server status, and tracks playtime.
- **Thank-you levels** (formerly Lespy): members earn XP when someone thanks them, level up, and can earn reward roles.

Everything is a slash command. Staff commands are hidden from members who can't use them.

## Features

- **Thank-you XP.** Reply to or mention someone with *thanks*, *ty* or *thx* (whole words only), or use `/thank`. They get 1 XP and the message gets a ✨. Each person can thank once a minute.
- **Level-ups with rewards.** Level-ups are announced with an embed. Optionally, members get a role at chosen levels.
- **Ranks and leaderboard.** `/rank` shows a progress bar and your position. `/leaderboard` has page buttons.
- **Live server monitor.** Joins and leaves are grouped into one embed per update, with how long each player stayed. The bot posts once when the server goes offline and once when it comes back. Its status shows the player count.
- **Playtime history.** Every session is kept, so `/playtime` ranks players and can search by name. Players whose FiveM identifiers include Discord are linked to their account.
- **Per-server settings.** Each Discord server has its own game server, channels, levels and rewards.

## Setup

Requires **Node.js 22.13 or newer**. The bot uses Node's built-in SQLite, so there is nothing to compile.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, turn on **Message Content Intent**. The bot needs it to notice "thanks".
2. Invite the bot with the `bot` and `applications.commands` scopes. It needs these permissions: Send Messages, Embed Links, Add Reactions, Manage Messages (for `/purge`) and Manage Roles (for level rewards).
3. Install and configure:
   ```sh
   git clone https://github.com/kaan0d/rejs.git
   cd rejs
   npm install
   ```
   Create a `.env` file:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   # Optional, defaults to rejs.db
   DB_PATH=rejs.db
   ```
4. Run it with `npm start`. Slash commands register automatically on startup.
5. In Discord, run `/config monitor address:1.2.3.4:30120 channel:#server-log`.

The monitor reads the standard FiveM endpoints `/players.json` and `/dynamic.json`. It polls every 10 seconds.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/help` | Everyone | Lists the commands you can use. |
| `/rank [user]` | Everyone | Shows level, XP progress bar, rank and thanks received. |
| `/leaderboard` | Everyone | Shows the top members, 10 per page. |
| `/thank <user>` | Everyone | Gives someone 1 XP. |
| `/server` | Everyone | Shows live status, player count, ping and map. |
| `/players [online\|recent]` | Everyone | Lists who is online now, or who left recently. |
| `/playtime [player]` | Everyone | Shows the top playtime, or searches by in-game name. |
| `/ping` | Everyone | Shows bot latency. |
| `/config monitor\|monitor-off\|levelup-channel\|show` | Manage Server | Sets up the game server and the announcement channels. |
| `/levelrole add\|remove` | Manage Roles | Sets the role rewards for reaching a level. |
| `/xp add\|set-level\|reset\|reset-all` | Manage Server | Edits members' levels. `reset-all` is for administrators only and asks for confirmation. |
| `/purge <amount> [user]` | Manage Messages | Deletes recent messages, optionally from one member only. |

You can change who sees each staff command in **Server Settings → Integrations**.

## Development

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).
