process.env.DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const levels = require('../src/levels');
const monitor = require('../src/monitor');

test('xp curve is clamped between 10 and 1000', () => {
  assert.equal(levels.requiredXp(1), 10);
  assert.equal(levels.requiredXp(10), 24);
  assert.equal(levels.requiredXp(499), 1000);
});

test('applyXp carries leftover xp across several level-ups', () => {
  assert.deepEqual(levels.applyXp({ level: 1, xp: 0 }, 9), { level: 1, xp: 9 });
  assert.deepEqual(levels.applyXp({ level: 1, xp: 9 }, 1), { level: 2, xp: 0 });
  assert.deepEqual(levels.applyXp({ level: 1, xp: 0 }, 25), { level: 3, xp: 5 });
  assert.deepEqual(levels.applyXp({ level: 499, xp: 0 }, 5000), { level: levels.MAX_LEVEL, xp: 0 });
});

test('thank words match whole words only', () => {
  for (const text of ['ty!', 'Thanks man', 'thank you <@1>', 'thx']) assert.ok(levels.THANK_WORDS.test(text), text);
  for (const text of ['party time', 'pretty', 'thankful']) assert.ok(!levels.THANK_WORDS.test(text), text);
});

test('thank grants xp, blocks self-thanks and enforces the cooldown', () => {
  const guild = { id: 'g1' };
  const giver = { id: 'a', bot: false };
  const target = { id: 'b', bot: false };
  assert.ok(levels.thank(guild, giver, giver).error);
  assert.ok(levels.thank(guild, giver, { id: 'bot', bot: true }).error);
  assert.deepEqual(levels.thank(guild, giver, target).after, { level: 1, xp: 1, thanks: 1 });
  assert.ok(levels.thank(guild, giver, target).error);
  assert.equal(levels.rankOf('g1', levels.getProgress('g1', 'b')), 1);
});

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
