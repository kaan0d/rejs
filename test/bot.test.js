process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const monitor = require('../src/monitor');

test('server addresses are normalized', () => {
  assert.equal(monitor.normalizeServerUrl('1.2.3.4'), 'http://1.2.3.4:30120');
  assert.equal(monitor.normalizeServerUrl('1.2.3.4:30125'), 'http://1.2.3.4:30125');
  assert.equal(monitor.normalizeServerUrl('https://play.example.com/'), 'https://play.example.com');
  assert.equal(monitor.normalizeServerUrl('not a host'), null);
});

test('durations read naturally', () => {
  assert.equal(monitor.formatDuration(59_000), '0m');
  assert.equal(monitor.formatDuration(3_720_000), '1h 2m');
  assert.equal(monitor.formatDuration(90_000_000), '1d 1h');
});

const { parseDuration } = require('../src/util');
const mod = require('../src/moderation');
const scheduler = require('../src/scheduler');
const { db } = require('../src/db');

test('durations parse from short text', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('2D'), 172_800_000);
  for (const bad of ['', '10', 'abc', '5x', '0m']) assert.equal(parseDuration(bad), null, bad);
});

test('user ids are pulled from mentions and pasted lists', () => {
  assert.deepEqual(mod.parseIds('<@123456789012345678>, 223456789012345678 223456789012345678 junk 42'),
    ['123456789012345678', '223456789012345678']);
});

test('moderators cannot act on themselves, the owner or higher roles', () => {
  const guild = { ownerId: 'owner', members: { me: { id: 'bot' } } };
  const member = (id, position) => ({ id, guild, roles: { highest: { position } }, kickable: true });
  const moderator = member('mod', 5);
  assert.match(mod.checkTarget(moderator, moderator, 'kick'), /yourself/);
  assert.match(mod.checkTarget(moderator, member('owner', 1), 'kick'), /owner/);
  assert.match(mod.checkTarget(moderator, member('boss', 5), 'kick'), /equal to or higher/);
  assert.equal(mod.checkTarget(moderator, member('user', 1), 'kick'), null);
  assert.match(mod.checkTarget(moderator, { ...member('user', 1), kickable: false }, 'kick'), /I can't kick/);
});

test('scheduler posts once and skips runs missed while offline', async () => {
  const hour = 3_600_000;
  const due = Date.now() - 3.5 * hour;
  db.prepare("INSERT INTO schedules (guild_id, channel_id, message, interval_ms, next_run_at) VALUES ('g', 'c', 'hi', ?, ?)").run(hour, due);
  const sent = [];
  await scheduler.run({ channels: { cache: { get: () => ({ send: async (m) => sent.push(m) }) } } });
  assert.deepEqual(sent, ['hi']);
  const { next_run_at } = db.prepare('SELECT next_run_at FROM schedules').get();
  assert.equal(next_run_at, due + 4 * hour);
});
