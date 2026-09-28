const { db } = require('./db');
const { expireBans } = require('./moderation');
const tickets = require('./tickets');

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

// Scheduled messages, temporary bans and ticket auto-close share one timer.
const tick = (client) => Promise.all([run(client), expireBans(client), tickets.checkInactive(client)]).catch((e) => console.error('Scheduler:', e));
const start = (client) => {
  tick(client);
  setInterval(() => tick(client), TICK_MS);
};

module.exports = { start, run };
