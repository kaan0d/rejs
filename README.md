# rejs

**rejs** is a Discord moderation and automation bot, with a FiveM server monitor built in.

Everything is a slash command. Staff commands are hidden from members who can't use them.

## Features

- **Moderation with a paper trail.** Warnings, timeouts, kicks, bans, channel locks and slowmode. Every action is posted to the mod log channel, written to Discord's audit log with the moderator's name, and sent to the member by DM when possible. The bot won't let a moderator act on someone with an equal or higher role.
- **Warning escalation.** Members can be timed out or kicked automatically after a set number of warnings.
- **Bulk actions.** Ban up to 200 user IDs in one request (useful in a raid), kick or time out a list of members, or give or take a role across the whole server. Every bulk action asks for confirmation first.
- **AutoMod.** `/automod` switches on Discord's own filters: blocked words, invite links, mention spam and spam. Discord enforces them even while the bot is offline.
- **Auto-role.** New members get a role when they join, or after they accept the rules.
- **Scheduled messages.** Repeating messages such as rules reminders or restart warnings.
- **FiveM server monitor.** Joins and leaves are grouped into one embed per update, with how long each player stayed. The bot posts once when the server goes offline and once when it comes back. Its status shows the player count. `/playtime` ranks players from the recorded sessions.
- **Per-server settings.** Each Discord server has its own channels, rules and game server.

## Setup

Requires **Node.js 22.13 or newer**. The bot uses Node's built-in SQLite, so there is nothing to compile.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, turn on **Server Members Intent**. Auto-role and bulk roles need it.
2. Invite the bot with the `bot` and `applications.commands` scopes. Giving it **Administrator** is simplest. At minimum it needs: Send Messages, Embed Links, Manage Messages, Manage Roles, Manage Channels, Moderate Members, Kick Members, Ban Members and Manage Server (for AutoMod and bulk bans). Put the bot's role above every role it should manage.
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
5. In Discord, run `/config modlog channel:#mod-log`. Then run `/automod`, so AutoMod alerts go to the mod log too.

The monitor reads the standard FiveM endpoints `/players.json` and `/dynamic.json`. It polls every 10 seconds. Turn it on with `/config monitor address:1.2.3.4:30120 channel:#server-log`.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/help` | Everyone | Lists the commands you can use. |
| `/ping` | Everyone | Shows bot latency. |
| `/server` | Everyone | Shows live game server status, player count, ping and map. |
| `/players [online\|recent]` | Everyone | Lists who is online now, or who left recently. |
| `/playtime [player]` | Everyone | Shows the top playtime, or searches by in-game name. |
| `/warn <user> <reason>` | Moderate Members | Warns a member. Counts toward warning escalation. |
| `/warnings list\|remove\|clear` | Moderate Members | Views or removes a member's warnings. |
| `/timeout <user> <duration>` / `/untimeout <user>` | Moderate Members | Mutes a member for a duration like `10m` or `1d` (up to 28 days), or lifts it. |
| `/kick <user>` | Kick Members | Removes a member from the server. |
| `/ban <user> [delete_messages]` / `/unban <user_id>` | Ban Members | Bans a user, even one who already left, or lifts a ban. |
| `/lock [channel]` / `/unlock [channel]` | Manage Channels | Stops or restores posting for everyone except staff. |
| `/slowmode <delay> [channel]` | Manage Channels | Sets a slowmode like `5s` or `1m`, or `0` to turn it off. |
| `/purge <amount> [user]` | Manage Messages | Deletes recent messages, optionally from one member only. |
| `/bulk ban\|kick\|timeout <users>` | Administrator | Acts on up to 200 pasted user IDs or mentions. |
| `/bulk role-give\|role-take <role> [only_with]` | Administrator | Gives or takes a role for everyone, or for members who have another role. |
| `/automod words\|invites\|mentions\|spam\|show` | Manage Server | Turns Discord's AutoMod filters on or off. |
| `/schedule add\|list\|remove` | Manage Server | Sets up repeating messages, at least 10 minutes apart. |
| `/config modlog\|autorole\|warn-escalation\|monitor\|monitor-off\|show` | Manage Server | Sets up the mod log, auto-role, warning escalation and game server. |

You can change who sees each staff command in **Server Settings → Integrations**.

## Development

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).
