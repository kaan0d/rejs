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

const { setSetting } = require('../src/db');

const fakeGuild = (id) => ({ id, channels: { cache: new Map() } });
const user = (id) => ({ id, tag: `user${id}` });

test('cases are numbered per server', async () => {
  const a = fakeGuild('cases-a');
  const b = fakeGuild('cases-b');
  assert.equal(await mod.recordCase(a, { action: 'warn', user: user('1'), moderator: user('m'), reason: 'x' }), 1);
  assert.equal(await mod.recordCase(a, { action: 'note', user: user('1'), moderator: user('m'), reason: 'y' }), 2);
  assert.equal(await mod.recordCase(b, { action: 'kick', user: user('1'), moderator: user('m') }), 1);
  assert.equal(mod.getCase('cases-b', 1).reason, 'No reason given');
});

test('warnings stop counting when removed or expired', async () => {
  const g = fakeGuild('warn-g');
  for (let n = 0; n < 3; n++) await mod.recordCase(g, { action: 'warn', user: user('7'), moderator: user('m'), reason: 'r' });
  assert.equal(mod.activeWarnings('warn-g', '7'), 3);
  db.prepare("UPDATE cases SET active = 0 WHERE guild_id = 'warn-g' AND number = 1").run();
  db.prepare("UPDATE cases SET created_at = ? WHERE guild_id = 'warn-g' AND number = 2").run(Date.now() - 40 * 86_400_000);
  assert.equal(mod.activeWarnings('warn-g', '7'), 2);
  setSetting('warn-g', 'warn_expiry_ms', 30 * 86_400_000);
  assert.equal(mod.activeWarnings('warn-g', '7'), 1);
});

test('temporary bans are lifted once and logged as an unban case', async () => {
  const removed = [];
  const g = { ...fakeGuild('tb-g'), bans: { remove: async (id) => { removed.push(id); return user(id); } } };
  await mod.recordCase(g, { action: 'ban', user: user('9'), moderator: user('m'), durationMs: 1, expiresAt: Date.now() - 1 });
  await mod.recordCase(g, { action: 'ban', user: user('8'), moderator: user('m'), durationMs: 1, expiresAt: Date.now() + 86_400_000 });
  const client = { user: user('bot'), guilds: { cache: new Map([['tb-g', g]]) } };
  await mod.expireBans(client);
  await mod.expireBans(client);
  assert.deepEqual(removed, ['9']);
  assert.equal(mod.getCase('tb-g', 3).action, 'unban');
});

test('a new ban or manual unban cancels a pending temporary ban', async () => {
  const g = fakeGuild('tb-cancel');
  await mod.recordCase(g, { action: 'ban', user: user('5'), moderator: user('m'), expiresAt: Date.now() - 1 });
  mod.closeBans('tb-cancel', '5');
  assert.equal(mod.getCase('tb-cancel', 1).active, 0);
});

test('saved reasons autocomplete by partial match', () => {
  for (const text of ['Spam', 'NSFW content', 'Advertising spam links']) db.prepare("INSERT INTO reasons VALUES ('rs', ?)").run(text);
  assert.deepEqual(mod.reasonChoices('rs', 'spam').map((c) => c.value), ['Advertising spam links', 'Spam']);
  assert.equal(mod.reasonChoices('other-guild', '').length, 0);
});

test('decancer makes names readable', () => {
  assert.equal(mod.decancer('𝓚𝓪𝓪𝓷'), 'Kaan');
  assert.equal(mod.decancer('!!! Hoister'), 'Hoister');
  assert.equal(mod.decancer('Z̷̢̛a̶̧̛l̵̢̛g̴̨̛ơ̵̢'), 'Zalgo');
  assert.equal(mod.decancer('A​l​i'), 'Ali');
  assert.equal(mod.decancer('Çağrı'), 'Çağrı');
  assert.equal(mod.decancer('ﾠ​'), 'Moderated nickname');
});

const antispam = require('../src/antispam');
const antinuke = require('../src/antinuke');
const antiraid = require('../src/antiraid');
const gate = require('../src/gate');
const { setFeature, getFeature } = require('../src/db');

test('anti-spam catches floods, repeats, caps, emojis and links', () => {
  const cfg = { ...antispam.DEFAULTS, enabled: true };
  const t = 1_000_000;
  for (let n = 0; n < 5; n++) assert.equal(antispam.check('f', `msg ${n}`, cfg, t + n * 100), null);
  assert.match(antispam.check('f', 'msg 5', cfg, t + 500), /too fast/);
  assert.equal(antispam.check('d', 'buy now', cfg, t), null);
  assert.equal(antispam.check('d', 'Buy now', cfg, t + 2000), null);
  assert.match(antispam.check('d', 'buy now ', cfg, t + 4000), /same message/);
  assert.match(antispam.check('c', 'WHY IS NOBODY ANSWERING', cfg, t), /capital/);
  assert.equal(antispam.check('c2', 'OK lol', cfg, t), null);
  assert.match(antispam.check('e', '🔥'.repeat(11), cfg, t), /emojis/);
  const links = { ...cfg, links: 'allowlist', allowedDomains: ['youtube.com'] };
  assert.equal(antispam.check('l', 'look https://www.youtube.com/watch?v=1', links, t), null);
  assert.equal(antispam.check('l2', 'https://m.youtube.com/x', links, t), null);
  assert.match(antispam.check('l3', 'free nitro https://steamcommunity.gift/x', links, t), /steamcommunity\.gift/);
});

test('anti-nuke fires once the limit is reached inside the window', () => {
  const cfg = { enabled: true, limit: 3, seconds: 10 };
  assert.equal(antinuke.track('g', 'x', 'ban', cfg, 0), null);
  assert.equal(antinuke.track('g', 'x', 'ban', cfg, 1000), null);
  assert.equal(antinuke.track('g', 'y', 'ban', cfg, 1500), null);
  assert.equal(antinuke.track('g', 'x', 'channel delete', cfg, 20_000), null);
  assert.equal(antinuke.track('g', 'x', 'ban', cfg, 21_000), null);
  assert.equal(antinuke.track('g', 'x', 'role delete', cfg, 22_000).length, 3);
});

test('anti-raid starts raid mode at the join limit and ending it restores verification', async () => {
  const levels = [];
  const guild = {
    id: 'raid-g',
    verificationLevel: 1,
    roles: { everyone: { id: 'raid-g' } },
    channels: { cache: new Map() },
    members: { fetch: async () => null },
    fetchOwner: async () => ({ send: async () => {} }),
    setVerificationLevel: async (level) => { levels.push(level); guild.verificationLevel = level; },
  };
  setFeature('raid-g', 'antiraid', { ...antiraid.DEFAULTS, enabled: true, joins: 3, seconds: 60 });
  for (let n = 0; n < 3; n++) await antiraid.onJoin({ id: `u${n}`, guild, kickable: false });
  assert.equal(getFeature('raid-g', 'raid_state', antiraid.IDLE).active, true);
  assert.deepEqual(levels, [4]);
  assert.match(await antiraid.endRaid(guild, { id: 'm' }), /verification level restored/);
  assert.deepEqual(levels, [4, 1]);
  assert.equal(getFeature('raid-g', 'raid_state', antiraid.IDLE).active, false);
});

test('age gate only quarantines new human accounts when on', () => {
  const member = (ageDays, bot = false) => ({ guild: { id: 'age-g' }, user: { bot, createdTimestamp: Date.now() - ageDays * 86_400_000 } });
  assert.equal(gate.shouldQuarantine(member(1)), false);
  setFeature('age-g', 'agegate', { ...gate.AGE_DEFAULTS, enabled: true, minAgeMs: 7 * 86_400_000 });
  assert.equal(gate.shouldQuarantine(member(1)), true);
  assert.equal(gate.shouldQuarantine(member(30)), false);
  assert.equal(gate.shouldQuarantine(member(1, true)), false);
});
