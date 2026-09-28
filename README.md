# rejs

**rejs** is a Discord moderation and automation bot, with a FiveM server monitor built in.

Everything is a slash command. Staff commands are hidden from members who can't use them.

## Features

- **Moderation with a paper trail.** Warnings, timeouts, kicks, bans (permanent or timed), softbans, channel locks and slowmode. Every action becomes a numbered case in the mod log and Discord's audit log, and the member gets a DM when possible. `/history` shows a member's full record, including private staff notes. The bot won't let a moderator act on someone with an equal or higher role.
- **Saved reasons.** Admins save common reasons like *Spam*, and the reason box suggests them as you type.
- **Ban appeals.** Ban DMs include an Appeal button. Appeals arrive in a staff channel with Accept and Deny buttons; accepted members get a single-use invite back.
- **Event logs.** Separate channels for message edits and deletes, member joins, leaves and changes (new accounts are flagged), and voice activity. Channels and roles can be left out of the logs.
- **Warning escalation.** Members can be timed out or kicked automatically after a set number of warnings. Warnings can expire after a set time.
- **Bulk actions.** Ban up to 200 user IDs in one request (useful in a raid), kick or time out a list of members, or give or take a role across the whole server. Every bulk action asks for confirmation first.
- **AutoMod.** `/automod` switches on Discord's own filters: blocked words, invite links, mention spam and spam. Discord enforces them even while the bot is offline.
- **Auto-role.** New members get a role when they join, or after they accept the rules.
- **Scheduled messages.** Repeating messages such as rules reminders or restart warnings.
- **FiveM server monitor.** Joins and leaves are grouped into one embed per update, with how long each player stayed. The bot posts once when the server goes offline and once when it comes back. Its status shows the player count. `/playtime` ranks players from the recorded sessions.
- **Per-server settings.** Each Discord server has its own channels, rules and game server.

## Setup

Requires **Node.js 22.13 or newer**. The bot uses Node's built-in SQLite, so there is nothing to compile.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, turn on **Server Members Intent** (required). Turn on **Message Content Intent** too if you want message text in the logs. Without it the bot still runs, but deleted messages are logged without their text and edits are not logged.
2. Invite the bot with the `bot` and `applications.commands` scopes. Giving it **Administrator** is simplest. At minimum it needs: View Channels, Send Messages, Embed Links, Attach Files, Manage Messages, Manage Roles, Manage Channels, Manage Nicknames, Moderate Members, Kick Members, Ban Members, Create Invite (for accepted appeals) and Manage Server (for AutoMod and bulk bans). Put the bot's role above every role it should manage.
3. Install and configure:
   ```sh
   git clone https://github.com/kaan0d/rejs.git
   cd rejs
   npm install
   ```
   Copy `.env.example` to `.env` and fill it in:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   # true: pull and restart automatically when a new commit reaches GitHub
   DEV_RESTART=false
   # Optional: your own server ID. Owner commands register only there
   DEV_GUILD_ID=
   ```
4. Run it with `npm start`, or on a server with pm2 (see below). Slash commands register automatically on startup.
5. In Discord, run `/config modlog channel:#mod-log`, then `/logs set` for each log type and `/config appeals` if you take appeals. Run `/automod` after setting the mod log, so AutoMod alerts go there too.

The monitor reads the standard FiveM endpoints `/players.json` and `/dynamic.json`. It polls every 10 seconds. Turn it on with `/config monitor address:1.2.3.4:30120 channel:#server-log`.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/help` | Everyone | Lists the commands you can use. |
| `/ping` | Everyone | Shows bot latency. |
| `/userinfo [user]` / `/serverinfo` / `/avatar [user]` | Everyone | Shows account age, join date and roles; server stats; or a full-size avatar and banner. Staff also see the member's record in `/userinfo`. |
| `/server` | Everyone | Shows live game server status, player count, ping and map. |
| `/players [online\|recent]` | Everyone | Lists who is online now, or who left recently. |
| `/playtime [player]` | Everyone | Shows the top playtime, or searches by in-game name. |
| `/warn <user> <reason>` | Moderate Members | Warns a member. Counts toward warning escalation. |
| `/history <user>` | Moderate Members | Shows every case and note for a member. |
| `/case view\|reason <number>` | Moderate Members | Shows a case, or changes its reason. |
| `/note add\|remove` | Moderate Members | Adds or removes a private staff note. |
| `/warnings list\|remove\|clear` | Moderate Members | Views a member's warnings, or stops them from counting. |
| `/timeout <user> <duration>` / `/untimeout <user>` | Moderate Members | Mutes a member for a duration like `10m` or `1d` (up to 28 days), or lifts it. |
| `/kick <user>` | Kick Members | Removes a member from the server. |
| `/ban <user> [duration] [delete_messages]` / `/unban <user_id>` | Ban Members | Bans a user, even one who already left. With a duration like `7d`, the ban lifts itself. |
| `/softban <user>` | Ban Members | Bans and unbans at once to delete someone's messages. They can rejoin. |
| `/lock [channel]` / `/unlock [channel]` | Manage Channels | Stops or restores posting for everyone except staff. |
| `/slowmode <delay> [channel]` | Manage Channels | Sets a slowmode like `5s` or `1m`, or `0` to turn it off. |
| `/purge <amount> [user]` | Manage Messages | Deletes recent messages, optionally from one member only. |
| `/role add\|remove <user> <role>` | Manage Roles | Gives or takes one member's role. |
| `/nick <user> [nickname]` | Manage Nicknames | Changes or resets a nickname. |
| `/decancer [user]` | Manage Nicknames | Makes fancy, invisible or zalgo names readable, for one member or everyone. |
| `/bulk ban\|kick\|timeout <users>` | Administrator | Acts on up to 200 pasted user IDs or mentions. |
| `/bulk role-give\|role-take <role> [only_with]` | Administrator | Gives or takes a role for everyone, or for members who have another role. |
| `/automod words\|invites\|mentions\|spam\|show` | Manage Server | Turns Discord's AutoMod filters on or off. |
| `/schedule add\|list\|remove` | Manage Server | Sets up repeating messages, at least 10 minutes apart. |
| `/logs set\|ignore\|unignore\|show` | Manage Server | Chooses the log channels and what they skip. |
| `/reasons add\|remove\|list` | Manage Server | Manages saved reasons. |
| `/config modlog\|appeals\|autorole\|warn-escalation\|monitor\|monitor-off\|show` | Manage Server | Sets up the mod log, appeals, auto-role, warning escalation and game server. |

You can change who sees each staff command in **Server Settings → Integrations**.

## Running on a server

Use [pm2](https://pm2.keymetrics.io/) to keep the bot running and restart it after crashes or reboots:

```sh
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # prints one command to run with sudo, so the bot starts on boot
```

With `DEV_RESTART=true`, the bot checks GitHub every minute. When a new commit arrives, it pulls it, reinstalls packages if `package.json` changed, and restarts. With `DEV_RESTART=false` nothing happens until you run `/update`.

### Owner commands

Only the bot's owner (the application owner in the Developer Portal, or its team members) can use these. Set `DEV_GUILD_ID` so they appear only in your own server.

| Command | What it does |
| --- | --- |
| `/restart` | Restarts the bot. |
| `/update` | Pulls the latest commit from GitHub and restarts, whatever `DEV_RESTART` is set to. |

## Development

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).
