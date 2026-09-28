const { db } = require('./db');
const { expireBans } = require('./moderation');
const tickets = require('./tickets');
const { deliverReminders } = require('./automation');
const { checkGiveaways } = require('./giveaways');
const { purgeDeparted } = require('./ops');
const journal = require('./journal');
const backup = require('./backup');
const snapshots = require('./snapshots');

const TICK_MS = 30_000;

async function run(client) {
  const now = Date.now();
  for (const s of db.prepare('SELECT * FROM schedules WHERE next_run_at <= ?').all(now)) {
    // Jump to the next future slot, so runs missed while the bot was offline aren't all posted at once.
    const next = s.next_run_at + (Math.floor((now - s.next_run_at) / s.interval_ms) + 1) * s.interval_ms;
    db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next, s.id);
    await client.channels.cache.get(s.channel_id)?.send(s.message)
      .catch((e) => console.error(`Schedule #${s.id} failed: ${e.message}`));
  }
}

// Everything time-based shares one timer. The daily database backup and server snapshots
// run when due; old undo history and departed servers' data are cleaned up.
const JOBS = {
  schedules: run,
  'temporary bans': expireBans,
  'ticket auto-close': tickets.checkInactive,
  reminders: deliverReminders,
  giveaways: checkGiveaways,
  'departed servers': () => purgeDeparted(),
  'undo history': () => journal.purgeOld(),
  'database backup': () => backup.backup(),
  'server snapshots': snapshots.autoTake,
};

// Each job fails on its own: a synchronous throw or a rejection is logged, the rest still run.
const tick = (client) => Promise.all(Object.entries(JOBS).map(([name, job]) =>
  Promise.resolve().then(() => job(client)).catch((e) => console.error(`Scheduler (${name}):`, e))));
const start = (client) => {
  tick(client);
  setInterval(() => tick(client), TICK_MS);
};

module.exports = { start, run };
