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
