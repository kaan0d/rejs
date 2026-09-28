# rejs

**rejs** is a Discord moderation and automation bot, with a FiveM server monitor built in.

Everything is a slash command. Staff commands are hidden from members who can't use them.

## Features

- **Moderation with a paper trail.** Warnings, timeouts, kicks, bans (permanent or timed), softbans, channel locks and slowmode. Every action becomes a numbered case in the mod log and Discord's audit log, and the member gets a DM when possible. `/history` shows a member's full record, including private staff notes. The bot won't let a moderator act on someone with an equal or higher role.
- **Saved reasons.** Admins save common reasons like *Spam*, and the reason box suggests them as you type.
- **Ban appeals.** Ban DMs include an Appeal button. Appeals arrive in a staff channel with Accept and Deny buttons; accepted members get a single-use invite back.
- **Event logs.** Separate channels for message edits and deletes, member joins, leaves and changes (new accounts are flagged), and voice activity. Channels and roles can be left out of the logs.
- **Warning escalation.** Members can be timed out or kicked automatically after a set number of warnings. Warnings can expire after a set time.
- **Anti-raid.** When many accounts join at once (20 in 60 seconds by default), the bot can raise the verification level, lock channels and kick the raiders, and it pings staff. One button undoes it all.
- **Anti-nuke.** If any account except the owner bans, kicks, or deletes channels or roles too fast, the bot strips its roles and alerts the owner. Protects against hijacked admin accounts. Only the server owner can change this setting.
- **Anti-spam.** Floods, repeated messages, all-caps, emoji walls and links (block all, or allow only chosen domains). Spam is deleted and counts as a warning, so escalation takes over. Needs the Message Content intent.
- **Age gate.** Accounts younger than a set age get a Quarantine role that only sees a quarantine channel. The bot creates both. Staff approve, kick or ban them with buttons in the mod log.
- **Verification.** A panel with a button that gives members a role.
- **Tickets.** A panel with a button per topic (Support, Report a player, ...). Each ticket opens as a private thread after a short form, one per member. Staff claim tickets, quiet tickets are warned and closed automatically, an HTML transcript goes to a log channel, and the member rates the help from 1 to 5 stars.
- **Reports.** Right-click a message → Apps → Report message, or `/report`. Staff get the report with Delete, Warn, Timeout 1h, Ban and Dismiss buttons, and the reporter hears back when it's handled.
- **Role menus.** Dropdowns where members pick their own roles, including pick-one menus for things like regions or colors.
- **Welcome and goodbye.** Editable messages with `{user}`, `{server}` and `{count}`, shown as a card with the member's avatar, plus an optional welcome DM. Skipped during a raid.
- **Suggestions.** `/suggest` posts to a channel with up and down vote buttons and a discussion thread. Staff mark suggestions accepted, denied or considering, and the author gets a DM. Members can post anonymously; staff can still see who.
- **Bulk actions.** Ban up to 200 user IDs in one request (useful in a raid), kick or time out a list of members, or give or take a role across the whole server. Every bulk action asks for confirmation first.
- **AutoMod.** `/automod` switches on Discord's own filters: blocked words, invite links, mention spam and spam. Discord enforces them even while the bot is offline.
- **Auto-role.** New members get a role when they join, or after they accept the rules.
- **Scheduled messages.** Repeating messages such as rules reminders or restart warnings.
- **Auto-replies and tags.** The bot answers messages that contain a phrase (optionally only in some channels; needs Message Content). Staff save text snippets and post them with `/tag`.
- **Sticky messages and auto-publish.** Keep a message at the bottom of a channel. Publish announcement posts to following servers automatically.
- **Reminders.** `/remind in:2h about:check the server`, in the channel or by DM.
- **Giveaways.** A button to enter, several winners, role and account-age requirements, ending early and rerolls.
- **Temporary voice channels.** Joining a hub creates a personal voice channel that disappears when empty. Owners rename it, set a limit, lock or hide it, let people in, remove people, and hand it over.
- **FiveM server monitor.** Joins and leaves are grouped into one embed per update, with how long each player stayed. The bot posts once when the server goes offline and once when it comes back. Its status shows the player count, a voice channel name can show it too, and `/server` shows a 24-hour chart with the peak. `/playtime` ranks players from the recorded sessions, and `/watchlist` pings staff when chosen players join.
- **Setup wizard.** When the bot joins a server it posts a short setup with buttons that create the staff log channels, a verification panel and the quarantine, all connected to the bot. `/setup` brings it back.
- **Undo.** Every staff command and staff button is recorded for 7 days. `/undo` lists them and reverses the one you pick: settings, saved records, created and deleted channels (deleted ones come back empty, and the bot's settings follow them), roles, permission changes, bans, timeouts, role and nickname changes, AutoMod rules and posted panels. Before anything changes it shows what will be reversed and what can't be (a kick, deleted messages). Each undo is posted to the mod log.
- **Privacy by default.** When the bot is removed from a server, that server's data is kept for 30 days in case it comes back, then deleted.
- **Per-server settings.** Each Discord server has its own channels, rules and game server.

## Setup

Requires **Node.js 22.13 or newer**. The bot uses Node's built-in SQLite, so there is nothing to compile.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, turn on **Server Members Intent** (required). Turn on **Message Content Intent** too if you want message text in the logs. Without it the bot still runs, but deleted messages are logged without their text and edits are not logged.
2. Invite the bot with the `bot` and `applications.commands` scopes. Giving it **Administrator** is simplest. At minimum it needs: View Channels, Send Messages, Embed Links, Attach Files, Manage Messages, Manage Roles, Manage Channels, Manage Nicknames, Moderate Members, Kick Members, Ban Members, Create Invite (for accepted appeals), View Audit Log (for anti-nuke), Create Public Threads, Create Private Threads, Send Messages in Threads and Manage Threads (for tickets and suggestions), Move Members (for temporary voice channels) and Manage Server (for AutoMod, bulk bans and raising the verification level during a raid). Put the bot's role above every role it should manage.
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
   # Optional: a channel in your server for error reports. Without it, errors come by DM
   ERROR_CHANNEL_ID=
   ```
4. Run it with `npm start`, or on a server with pm2 (see below). Slash commands register automatically on startup.
5. In Discord, run `/setup` and click the buttons, or set things up by hand with `/config modlog`, `/logs set` and `/config appeals`. Run `/automod` after the mod log exists, so AutoMod alerts go there too.

The monitor reads the standard FiveM endpoints `/players.json` and `/dynamic.json`. It polls every 10 seconds. Turn it on with `/config monitor address:1.2.3.4:30120 channel:#server-log`.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/help` | Everyone | Lists the commands you can use, by category. |
| `/tag <name> [for]` | Everyone | Posts a saved answer. |
| `/remind <in> <about> [dm]` / `/reminders list\|delete` | Everyone | Sets and manages your reminders. |
| `/voice rename\|limit\|lock\|unlock\|hide\|unhide\|allow\|kick\|transfer\|claim` | Everyone | Controls your temporary voice channel. |
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
| `/autoresponder add\|remove\|list` | Manage Server | Sets up automatic replies to phrases. |
| `/tags add\|edit\|remove\|list` | Manage Messages | Manages saved answers. |
| `/sticky set\|remove` | Manage Messages | Keeps a message at the bottom of a channel. |
| `/autopublish add\|remove\|list` | Manage Server | Publishes announcement posts automatically. |
| `/giveaway start\|end\|reroll\|list` | Manage Server | Runs giveaways. |
| `/tempvoice setup\|off` | Manage Channels | Creates the "join to create" voice channel. |
| `/watchlist add\|remove\|list` | Moderate Members | Pings staff when chosen players join the game server. |
| `/logs set\|ignore\|unignore\|show` | Manage Server | Chooses the log channels and what they skip. |
| `/protection` | Manage Server | Shows the state of every protection feature. |
| `/antiraid set\|end` | Manage Server | Sets raid detection and its actions, or ends raid mode. |
| `/antispam` | Manage Server | Sets the spam filters. Options you leave empty keep their value. |
| `/agegate set\|off` | Manage Server | Quarantines accounts younger than a minimum age. |
| `/verification setup\|off` | Manage Server | Posts a verify button that gives a role. |
| `/approve <user>` | Moderate Members | Lets a quarantined member in. |
| `/report <user> <reason>` | Everyone | Reports a member to the staff. Right-click a message → Apps → Report message works too. |
| `/suggest <idea> [anonymous]` | Everyone | Posts a suggestion. |
| `/suggestion accepted\|denied\|considering\|author` | Manage Messages | Answers a suggestion, or shows who posted it. |
| `/ticket category-add\|category-remove\|panel\|settings\|stats` | Manage Server | Sets up ticket types, the panel, transcripts and auto-close. |
| `/ticket add\|remove <user>` | Manage Threads | Adds or removes someone in the current ticket. |
| `/rolemenu create\|add\|remove` | Manage Roles | Builds dropdown role menus. |
| `/welcome set\|dm\|goodbye\|test\|off` | Manage Server | Sets the welcome, DM and goodbye messages. |
| `/antinuke` | Server owner | Sets how many destructive actions an account may do before losing its roles. |
| `/reasons add\|remove\|list` | Manage Server | Manages saved reasons. |
| `/setup` | Manage Server | Shows the setup wizard. |
| `/channel delete <channel>` | Manage Channels | Deletes a channel, or a category with or without its channels (it asks). Warns if the bot uses the channel. `/undo` recreates it, empty. |
| `/undo` | Manage Server | Reverses a staff action from the last 7 days. You only see actions whose command you are allowed to use. |
| `/config modlog\|reports\|suggestions\|appeals\|autorole\|warn-escalation\|monitor\|monitor-off\|show` | Manage Server | Sets up the mod log, report and suggestion channels, appeals, auto-role, warning escalation and game server. |

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
| `/stats` | Servers, members, uptime, memory, database size, version and the most used commands. |
| `/blacklist add\|remove\|list` | Makes the bot leave a server and refuse to rejoin it. |
| `/announce <message>` | Posts an update to every server's mod log. |

Unexpected errors are sent to `ERROR_CHANNEL_ID`, or to the owner by DM. The same error is reported at most once every 10 minutes.

## Development

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).
