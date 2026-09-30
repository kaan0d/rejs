# rejs

Discord moderation and automation bot with a built-in FiveM server monitor. Every command is a slash command, and every message is a Components V2 card.

## Features

- **Moderation:** warn, timeout, kick, ban (timed), softban, lock, slowmode, purge. Every action is a numbered case in the mod log, with DMs, `/history`, staff notes and role hierarchy checks.
- **Protection:** anti-raid (verification level, lockdown, kicks, one-button undo), anti-nuke (strips roles from accounts that delete too fast), anti-spam, age-gate quarantine, Discord AutoMod setup.
- **Recovery:** `/undo` reverses any staff action from the last 7 days. Daily role and channel snapshots feed `/restore`, and daily database backups are kept.
- **Community:** tickets (private threads, transcripts, ratings), reports, ban appeals, suggestions, role menus, welcome messages, giveaways, temporary voice channels, reminders, tags, auto-replies, sticky and scheduled messages.
- **FiveM monitor:** grouped join/leave logs, online/offline notices, player count in status, 24 h chart, playtime ranking, watchlist.
- **Operations:** setup wizard, per-server settings, event logs, staff activity stats, 30-day data retention after the bot leaves a server.

## Setup

Node.js 22.13+ (uses the built-in `node:sqlite`, nothing to compile).

1. Create a Discord application and enable **Server Members Intent**. **Message Content Intent** is optional; it is needed for message text in logs, anti-spam and auto-replies.
2. Invite the bot with the `bot` and `applications.commands` scopes and Administrator. Place its role above every role it should manage.
3. Install and configure:
   ```sh
   git clone https://github.com/kaan0d/rejs.git && cd rejs
   npm install
   cp .env.example .env
   ```
   ```env
   DISCORD_TOKEN=
   DEV_RESTART=false      # true: pull and restart on new commits
   DEV_GUILD_ID=          # optional: register owner commands only here
   ERROR_CHANNEL_ID=      # optional: error reports, otherwise DM to owner
   ```
4. Run `npm start`. Slash commands register on startup.
5. Run `/setup` in Discord. For the FiveM monitor: `/config monitor address:1.2.3.4:30120 channel:#server-log` (polls `/players.json` and `/dynamic.json` every 10 s).

`/help` lists the commands each member can use. Staff commands are hidden from members without the required permission. Per-command visibility can be changed under **Server Settings → Integrations**.

## Deployment

```sh
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

With `DEV_RESTART=true`, the bot checks GitHub every minute, pulls new commits, reinstalls dependencies if `package.json` changed, and restarts. Owner-only commands: `/restart`, `/update`, `/stats`, `/blacklist`, `/announce`, `/backup`. Errors are reported at most once per 10 minutes.

## Development

```sh
npm test
```

## License

MIT, see [LICENSE](LICENSE).
