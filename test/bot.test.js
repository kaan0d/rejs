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

const community = require('../src/community');
const tickets = require('../src/tickets');
const reports = require('../src/reports');
const { transcriptHtml } = require('../src/transcript');

test('role menus toggle roles, and pick-one menus swap them', () => {
  const held = new Set(['a']);
  assert.deepEqual(community.roleChanges(['a', 'b', 'c'], held, ['a', 'b'], false), { add: ['b'], remove: ['a'] });
  assert.deepEqual(community.roleChanges(['a', 'b', 'c'], held, ['c'], true), { add: ['c'], remove: ['a'] });
  assert.deepEqual(community.roleChanges(['a', 'b', 'c'], held, ['a'], true), { add: [], remove: ['a'] });
});

test('welcome variables are filled in', () => {
  const member = { toString: () => '<@1>', user: { username: 'kaan_' }, guild: { name: 'Respy', memberCount: 42 } };
  assert.equal(community.fill('Hi {user} ({username}), welcome to {server}. #{count}', member), String.raw`Hi <@1> (kaan\_), welcome to Respy. #42`);
});

test('transcripts escape HTML from messages', () => {
  const html = transcriptHtml({
    title: 'T', subtitle: 'S',
    messages: [{ content: '<script>alert(1)</script> **hi**', embeds: [], attachments: new Map(), createdTimestamp: 0,
      author: { bot: false, username: 'x', displayName: 'x', displayAvatarURL: () => 'a.png' } }],
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('<b>hi</b>'));
});

test('ticket category names become stable ids', () => {
  assert.equal(tickets.slug('Report a Player!'), 'report-a-player');
  assert.equal(tickets.slug('🛠️'), 'ticket');
});

test('quiet tickets get a warning, then close a day later', async () => {
  const sent = [];
  const thread = { send: async (t) => sent.push(t), setLocked: async () => {}, setArchived: async () => {}, messages: { fetch: async () => new Map() } };
  const client = {
    user: { tag: 'bot', toString: () => '<@bot>' },
    guilds: { cache: new Map() },
    channels: { fetch: async () => thread },
    users: { fetch: async () => null },
  };
  setFeature('tk-g', 'tickets', { ...tickets.DEFAULTS, inactiveHours: 1 });
  const old = Date.now() - 2 * 3_600_000;
  const { lastInsertRowid: id } = db.prepare("INSERT INTO tickets (guild_id, thread_id, user_id, category, reason, created_at, last_activity) VALUES ('tk-g', 'th1', 'u1', 'support', 'help', ?, ?)").run(old, old);
  await tickets.checkInactive(client);
  assert.match(sent[0], /quiet for 1 hours/);
  await tickets.checkInactive(client);
  assert.equal(sent.length, 1);
  db.prepare('UPDATE tickets SET warned_at = ? WHERE id = ?').run(Date.now() - 25 * 3_600_000, id);
  await tickets.checkInactive(client);
  assert.equal(tickets.getTicket(id).status, 'closed');
  assert.match(sent.at(-1), /closed by <@bot>: No activity/);
});

test('reports need a channel, block self-reports and have a cooldown', async () => {
  const posted = [];
  const guild = { id: 'rp-g', channels: { cache: new Map([['rc', { send: async (p) => posted.push(p) }]]) } };
  const reporter = { id: 'r1', toString: () => '<@r1>' };
  const target = { id: 't1', tag: 't#1', bot: false, toString: () => '<@t1>', displayAvatarURL: () => 'https://cdn.example/a.png' };
  assert.match(await reports.createReport(guild, reporter, target, 'spam'), /not set up/);
  setFeature('rp-g', 'reports', { channelId: 'rc' });
  assert.match(await reports.createReport(guild, reporter, reporter, 'x'), /yourself/);
  assert.equal(await reports.createReport(guild, reporter, target, 'spam'), null);
  assert.equal(posted.length, 1);
  assert.match(await reports.createReport(guild, reporter, target, 'again'), /report again/);
});

const automation = require('../src/automation');
const giveaways = require('../src/giveaways');

test('auto-responders match phrases, ignoring case, and respect channel limits', () => {
  db.prepare("INSERT INTO responders (guild_id, trigger, response, channels) VALUES ('ar', 'How do I join', 'IP: 1.2.3.4', '[]')").run();
  db.prepare("INSERT INTO responders (guild_id, trigger, response, channels) VALUES ('ar', 'rules', 'See #rules', '[\"c1\"]')").run();
  assert.equal(automation.matchResponder('ar', 'c9', 'hey HOW DO I JOIN the server?').response, 'IP: 1.2.3.4');
  assert.equal(automation.matchResponder('ar', 'c9', 'where are the rules'), null);
  assert.equal(automation.matchResponder('ar', 'c1', 'where are the rules').response, 'See #rules');
});

test('due reminders are sent once, falling back to DM', async () => {
  const sent = [];
  db.prepare("INSERT INTO reminders (user_id, channel_id, text, due_at) VALUES ('u', 'gone', 'check server', ?)").run(Date.now() - 1);
  db.prepare("INSERT INTO reminders (user_id, channel_id, text, due_at) VALUES ('u', 'c', 'later', ?)").run(Date.now() + 3_600_000);
  const client = { channels: { cache: new Map() }, users: { fetch: async () => ({ send: async (t) => sent.push(t) }) } };
  await automation.deliverReminders(client);
  await automation.deliverReminders(client);
  assert.deepEqual(sent, ['<@u>, reminder: check server']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n, 1);
});

test('giveaway winners must still qualify, and rerolls skip earlier winners', async () => {
  const { lastInsertRowid: id } = db.prepare("INSERT INTO giveaways (guild_id, channel_id, host_id, prize, winners, ends_at, required_role) VALUES ('gw', 'c', 'h', 'Nitro', 2, 0, 'vip')").run();
  for (const u of ['a', 'b', 'c', 'd']) db.prepare('INSERT INTO giveaway_entries VALUES (?, ?)').run(id, u);
  const member = (userId, roles) => ({ id: userId, roles: { cache: new Set(roles) }, user: { createdTimestamp: 0 } });
  const members = { a: member('a', ['vip']), b: member('b', ['vip']), c: member('c', []), d: member('d', ['vip']) };
  const guild = { members: { fetch: async (u) => members[u] ?? Promise.reject(new Error('left')) } };
  const g = giveaways.getGiveaway(id);
  const first = await giveaways.drawWinners(guild, g, 2);
  assert.equal(first.length, 2);
  assert.ok(!first.includes('c'));
  const reroll = await giveaways.drawWinners(guild, g, 5, first);
  assert.deepEqual(reroll.sort(), ['a', 'b', 'd'].filter((u) => !first.includes(u)).sort());
});

test('player history becomes an hourly sparkline with the peak', () => {
  const now = 10 * 86_400_000;
  const s = {};
  monitor.recordCount('ph', s, 10, now - 3 * 3_600_000);
  monitor.recordCount('ph', s, 99, now - 3 * 3_600_000 + 60_000); // too soon, skipped
  monitor.recordCount('ph', s, 40, now - 30 * 60_000);
  const { spark, peak, samples } = monitor.last24h('ph', now);
  assert.equal(samples, 2);
  assert.equal(peak.count, 40);
  assert.equal(spark.length, 24);
  assert.equal(spark.at(-1), '█');
  assert.equal(spark.at(-4), '▃');
});

test('watchlist entries accept names, identifiers and mentions', () => {
  assert.equal(monitor.watchKey('<@123456789012345678>'), '123456789012345678');
  assert.equal(monitor.watchKey(' license:abc '), 'license:abc');
});

const ops = require('../src/ops');

test('a departed server keeps its data for 30 days, then everything is deleted', async () => {
  const g = 'bye-g';
  setSetting(g, 'modlog_channel_id', 'c');
  setFeature(g, 'antispam', { enabled: true });
  await mod.recordCase(fakeGuild(g), { action: 'warn', user: user('1'), moderator: user('m'), reason: 'x' });
  const { lastInsertRowid: s } = db.prepare("INSERT INTO suggestions (guild_id, channel_id, user_id, anonymous, text, created_at) VALUES (?, 'c', 'u', 0, 'idea', 0)").run(g);
  db.prepare("INSERT INTO suggestion_votes VALUES (?, 'u', 1)").run(s);
  setSetting('stay-g', 'modlog_channel_id', 'c');

  const now = Date.now();
  db.prepare('INSERT INTO departed_guilds (guild_id, left_at) VALUES (?, ?)').run(g, now - 29 * 86_400_000);
  assert.equal(ops.purgeDeparted(now), 0);
  assert.equal(ops.purgeDeparted(now + 2 * 86_400_000), 1);

  for (const table of ['guild_settings', 'features', 'cases', 'suggestions']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(g).n, 0, table);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suggestion_votes WHERE suggestion_id = ?').get(s).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM guild_settings WHERE guild_id = 'stay-g'").get().n, 1);
});

test('blacklisting leaves the server and can be undone', async () => {
  let left = false;
  const client = { guilds: { cache: new Map([['bl-g', { name: 'Bad', leave: async () => { left = true; } }]]) } };
  assert.equal(await ops.blacklist(client, 'bl-g', 'spam'), 'Bad');
  assert.ok(left && ops.isBlacklisted('bl-g'));
  assert.ok(ops.unblacklist('bl-g'));
  assert.ok(!ops.isBlacklisted('bl-g'));
});

test('command usage is counted', () => {
  ops.countUsage('warn');
  ops.countUsage('warn');
  ops.countUsage('ban');
  assert.deepEqual(ops.topCommands(2).map((c) => [c.name, c.count]), [['warn', 2], ['ban', 1]]);
});

const journal = require('../src/journal');
const { getSettings } = require('../src/db');

const staff = (guildId, label) => ({ guildId, userId: 'mod', label, permissions: '32' });

test('undo restores settings, features and records changed by a command', async () => {
  setSetting('un-g', 'modlog_channel_id', 'before');
  await journal.run(staff('un-g', '/config modlog'), async () => {
    setSetting('un-g', 'modlog_channel_id', 'after');
    setFeature('un-g', 'reports', { channelId: 'r' });
    db.prepare("INSERT INTO tags (guild_id, name, content) VALUES ('un-g', 'rules', 'be nice')").run();
    db.prepare("UPDATE tags SET content = 'be kind' WHERE guild_id = 'un-g'").run();
  });
  const [entry] = journal.undoable('un-g');
  assert.equal(entry.label, '/config modlog');
  const result = await journal.undo({ id: 'un-g' }, entry.id, 'admin');
  assert.equal(result.rows, 4);
  assert.equal(getSettings('un-g').modlog_channel_id, 'before');
  assert.deepEqual(getFeature('un-g', 'reports', {}), {});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE guild_id = 'un-g'").get().n, 0);
  assert.equal(journal.undoable('un-g').length, 0);
  assert.equal(await journal.undo({ id: 'un-g' }, entry.id, 'admin'), null);
});

test('undo brings back deleted records', async () => {
  const { lastInsertRowid } = db.prepare("INSERT INTO responders (guild_id, trigger, response) VALUES ('del-g', 'hi', 'hello')").run();
  await journal.run(staff('del-g', '/autoresponder remove'), async () => {
    db.prepare('DELETE FROM responders WHERE id = ?').run(lastInsertRowid);
  });
  await journal.undo({ id: 'del-g' }, journal.undoable('del-g')[0].id, 'admin');
  assert.equal(db.prepare('SELECT response FROM responders WHERE id = ?').get(lastInsertRowid).response, 'hello');
});

test('commands that run at the same time keep separate undo entries', async () => {
  const pause = () => new Promise((r) => setTimeout(r, 5));
  await Promise.all([
    journal.run(staff('par-g', 'A'), async () => { await pause(); setSetting('par-g', 'autorole_id', 'a'); await pause(); }),
    journal.run(staff('par-g', 'B'), async () => { setSetting('par-g', 'modlog_channel_id', 'b'); await pause(); await pause(); }),
  ]);
  const byLabel = Object.fromEntries(journal.undoable('par-g').map((e) => [e.label, e.id]));
  await journal.undo({ id: 'par-g' }, byLabel.A, 'admin');
  assert.equal(getSettings('par-g').autorole_id, null);
  assert.equal(getSettings('par-g').modlog_channel_id, 'b');
});

test('undo reverses Discord changes newest first and reports what failed', async () => {
  const calls = [];
  const guild = {
    id: 'dc-g',
    channels: { cache: new Map([['new-ch', { delete: async () => calls.push('delete channel') }]]) },
    roles: { cache: new Map([['new-role', { delete: async () => calls.push('delete role') }]]) },
    members: { fetch: async () => ({ roles: { remove: async (r) => calls.push(`take ${r}`) }, timeout: async (ms) => calls.push(`timeout ${ms}`) }) },
    bans: { remove: async (u) => calls.push(`unban ${u}`), create: async () => { throw new Error('Missing Permissions'); } },
  };
  await journal.run(staff('dc-g', '/setup'), async () => {
    journal.created('role', { id: 'new-role' });
    journal.created('channel', { id: 'new-ch' });
    journal.memberRole({ id: 'u1' }, 'vip', true);
    journal.timeout({ id: 'u1', communicationDisabledUntilTimestamp: null });
    journal.banned('u2');
    journal.unbanned('u3');
    journal.cannotUndo('Kick (they have to rejoin themselves)');
  });
  const result = await journal.undo(guild, journal.undoable('dc-g')[0].id, 'admin');
  assert.deepEqual(calls, ['unban u2', 'timeout null', 'take vip', 'delete channel', 'delete role']);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /Missing Permissions/);
  assert.deepEqual(result.notes, ['Kick (they have to rejoin themselves)']);
});

test('read-only commands leave no undo entry, and entries expire after 7 days', async () => {
  await journal.run(staff('ro-g', '/warnings list'), async () => {});
  assert.equal(journal.undoable('ro-g').length, 0);
  await journal.run(staff('ro-g', '/tags add'), async () => { setSetting('ro-g', 'autorole_id', 'x'); });
  const now = Date.now();
  assert.equal(journal.undoable('ro-g', now + 6 * 86_400_000).length, 1);
  journal.purgeOld(now + 8 * 86_400_000);
  assert.equal(journal.undoable('ro-g', now).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM undo_rows WHERE tx NOT IN (SELECT id FROM undo_log)').get().n, 0);
});

test('undoing a category delete recreates it first, puts its channels back and repoints settings', async () => {
  const P = require('discord.js').ChannelType;
  let nextId = 900;
  const created = [];
  const moved = [];
  const guild = {
    id: 'ch-g',
    roles: { cache: new Map([['everyone', {}]]) },
    channels: {
      cache: new Map([['kept', { setParent: async (p) => moved.push(p) }]]),
      create: async (opts) => {
        const channel = { id: String(nextId++), ...opts };
        created.push(channel);
        guild.channels.cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  const overwrites = (list) => ({ cache: new Map(list.map((o) => [o.id, { ...o, allow: { bitfield: 1024n }, deny: { bitfield: 0n } }])) });
  const category = { id: 'cat', name: 'Staff', type: P.GuildCategory, parentId: null, rawPosition: 3, permissionOverwrites: overwrites([{ id: 'everyone', type: 0 }, { id: 'gone-role', type: 0 }]) };
  const logChannel = { id: 'log', name: 'mod-log', type: P.GuildText, parentId: 'cat', rawPosition: 1, topic: 'logs', rateLimitPerUser: 5, permissionOverwrites: overwrites([]) };
  setSetting('ch-g', 'modlog_channel_id', 'log');

  await journal.run(staff('ch-g', '/channel delete'), async () => {
    journal.deletedChannel(logChannel);
    journal.deletedChannel(category, ['kept']);
    journal.cannotUndo('Messages in the deleted channels (undo recreates them empty)');
  });
  const result = await journal.undo(guild, journal.undoable('ch-g')[0].id, 'admin');

  assert.deepEqual(result.failed, []);
  assert.deepEqual(created.map((c) => c.name), ['Staff', 'mod-log']);
  assert.equal(created[1].parent, created[0].id);
  assert.equal(created[1].topic, 'logs');
  assert.equal(created[1].rateLimitPerUser, 5);
  assert.deepEqual(created[0].permissionOverwrites.map((o) => o.id), ['everyone']);
  assert.deepEqual(moved, [created[0].id]);
  assert.equal(getSettings('ch-g').modlog_channel_id, created[1].id);
});

const snapshots = require('../src/snapshots');
const { Collection } = require('discord.js');

test('database backups are daily copies and only the last 7 are kept', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rejs-backup-'));
  const script = `
    const { setSetting } = require(${JSON.stringify(path.resolve('src/db'))});
    const backup = require(${JSON.stringify(path.resolve('src/backup'))});
    setSetting('g', 'modlog_channel_id', 'c');
    for (let day = 1; day <= 9; day++) backup.backup(new Date(Date.UTC(2026, 0, day)));
    const again = backup.backup(new Date(Date.UTC(2026, 0, 9)));
    console.log(JSON.stringify({ files: backup.list().map((f) => f.name), again }));`;
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], {
    env: { ...process.env, DB_PATH: path.join(tmp, 'live.db'), BACKUP_DIR: path.join(tmp, 'backups') },
  }).toString();
  const { files, again } = JSON.parse(out);
  assert.equal(files.length, 7);
  assert.equal(files[0], 'rejs-2026-01-03.db');
  assert.equal(again, null);
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(path.join(tmp, 'backups', files.at(-1)));
  assert.equal(copy.prepare("SELECT modlog_channel_id FROM guild_settings WHERE guild_id = 'g'").get().modlog_channel_id, 'c');
  copy.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('restore recreates deleted roles and channels, gives roles back and repoints settings', async () => {
  const P = require('discord.js').ChannelType;
  let next = 700;
  const given = [];
  const overwrites = (list) => ({ cache: new Collection(list.map((o) => [o.id, { ...o, allow: { bitfield: 1024n }, deny: { bitfield: 0n } }])) });
  const alice = { id: 'alice', roles: { add: async (r) => given.push(`alice+${r}`) } };
  const guild = {
    id: 'rs-g',
    members: {
      fetch: async () => null,
      cache: new Collection([['alice', alice]]),
      me: { permissions: { has: () => true, bitfield: 0n }, roles: { highest: { position: 10 } } },
    },
    roles: {
      cache: new Collection([
        ['rs-g', { id: 'rs-g', managed: false }],
        ['staff', { id: 'staff', name: 'Staff', color: 1, hoist: true, mentionable: false, managed: false, position: 5, permissions: { bitfield: 8n }, members: new Collection([['alice', alice]]) }],
      ]),
      create: async (o) => { const r = { id: `r${next++}`, ...o }; guild.roles.cache.set(r.id, r); return r; },
      setPositions: async () => {},
    },
    channels: {
      cache: new Collection([
        ['cat', { id: 'cat', name: 'Staff area', type: P.GuildCategory, parentId: null, rawPosition: 0, isThread: () => false, permissionOverwrites: overwrites([{ id: 'staff', type: 0 }]) }],
        ['log', { id: 'log', name: 'mod-log', type: P.GuildText, parentId: 'cat', rawPosition: 0, isThread: () => false, permissionOverwrites: overwrites([{ id: 'staff', type: 0 }]) }],
      ]),
      create: async (o) => { const c = { id: `c${next++}`, ...o }; guild.channels.cache.set(c.id, c); return c; },
    },
  };
  setSetting('rs-g', 'modlog_channel_id', 'log');
  const taken = await snapshots.take(guild);
  assert.deepEqual([taken.roles, taken.channels], [1, 2]);

  // The nuke: the role, the category and the log channel are gone.
  guild.roles.cache.delete('staff');
  guild.channels.cache.delete('cat');
  guild.channels.cache.delete('log');

  const snapshot = snapshots.list('rs-g')[0];
  const missing = snapshots.missing(guild, snapshot);
  assert.deepEqual(missing.channels.map((c) => c.name), ['Staff area', 'mod-log']);
  const result = await snapshots.restore(guild, snapshot);
  assert.deepEqual([result.roles, result.channels, result.members, result.failed.length], [1, 2, 1, 0]);

  const newRole = [...guild.roles.cache.values()].find((r) => r.name === 'Staff');
  const newCat = [...guild.channels.cache.values()].find((c) => c.name === 'Staff area');
  const newLog = [...guild.channels.cache.values()].find((c) => c.name === 'mod-log');
  assert.equal(newLog.parent, newCat.id);
  assert.deepEqual(newLog.permissionOverwrites.map((o) => o.id), [newRole.id]);
  assert.deepEqual(given, [`alice+${newRole.id}`]);
  assert.equal(getSettings('rs-g').modlog_channel_id, newLog.id);
  assert.deepEqual(snapshots.missing(guild, snapshots.list('rs-g')[0]), { roles: [], channels: [] });
});

const ui = require('../src/ui');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ComponentType: CT, MessageFlags: MF, Colors: C } = require('discord.js');

const types = (components) => components.map((c) => c.type);

test('plain replies become a colored card, keeping ephemeral', () => {
  const out = ui.modernize({ content: '✅ Saved.', flags: MF.Ephemeral });
  assert.equal(out.content, undefined);
  assert.equal(out.flags & MF.IsComponentsV2, MF.IsComponentsV2);
  assert.equal(out.flags & MF.Ephemeral, MF.Ephemeral);
  assert.deepEqual(types(out.components), [CT.Container]);
  assert.equal(out.components[0].accent_color, C.Green);
  assert.equal(out.components[0].components[0].content, 'Saved.');
  assert.equal(ui.modernize('❌ Nope').components[0].accent_color, C.Red);
});

test('embeds become cards with a thumbnail section, fields, footer and the buttons inside', () => {
  const embed = new EmbedBuilder().setColor(0x123456).setTitle('User').setDescription('About them')
    .setThumbnail('https://cdn.example/a.png').addFields({ name: 'Level', value: '5', inline: true }, { name: 'Roles', value: 'a\nb' })
    .setFooter({ text: 'ID 1' }).setTimestamp(1000);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('x').setLabel('X').setStyle(ButtonStyle.Primary));
  const out = ui.modernize({ content: '<@1>', embeds: [embed], components: [row], files: [new AttachmentBuilder(Buffer.from('hi'), { name: 't.html' })] });

  assert.deepEqual(types(out.components), [CT.TextDisplay, CT.Container]);
  assert.equal(out.components[0].content, '<@1>');
  const card = out.components[1];
  assert.equal(card.accent_color, 0x123456);
  assert.deepEqual(types(card.components), [CT.Section, CT.Separator, CT.TextDisplay, CT.Separator, CT.TextDisplay, CT.File, CT.ActionRow]);
  assert.match(card.components[0].components[0].content, /^### User\nAbout them$/);
  assert.equal(card.components[0].accessory.media.url, 'https://cdn.example/a.png');
  assert.equal(card.components[2].content, '**Level** · 5\n**Roles**\na\nb');
  assert.equal(card.components[4].content, '-# ID 1 · <t:1:f>');
  assert.equal(card.components[5].file.url, 'attachment://t.html');
});

test('edits drop the ephemeral flag, cards pass through, and long text is shortened', () => {
  assert.equal(ui.modernize({ content: 'x', flags: MF.Ephemeral }, { edit: true }).flags & MF.Ephemeral, 0);
  const already = { components: [], flags: MF.IsComponentsV2 };
  assert.deepEqual(ui.modernize(already), already);
  assert.equal(ui.modernize({ components: [] }), null);
  const long = ui.modernize({ embeds: [new EmbedBuilder().setDescription('a'.repeat(4000)).addFields({ name: 'b', value: 'c'.repeat(1000) })] });
  const text = JSON.stringify(long.components).match(/"content":"([^"]*)"/g).join('').length;
  assert.ok(text < 4000);
});

test('finishing a card swaps its buttons for a status line and recolors it', () => {
  const card = ui.modernize({ embeds: [new EmbedBuilder().setTitle('Report #1')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('a').setLabel('A').setStyle(ButtonStyle.Primary))] });
  const message = { flags: { has: (f) => f === MF.IsComponentsV2 }, content: '', embeds: [], components: card.components.map((c) => ({ toJSON: () => structuredClone(c) })) };
  const done = ui.finishCard(message, { status: 'Handled by mod', color: C.Green });
  const container = done.components[0];
  assert.equal(container.accent_color, C.Green);
  assert.ok(!container.components.some((c) => c.type === CT.ActionRow));
  assert.equal(container.components.at(-1).content, '-# Handled by mod');

  const legacy = { flags: { has: () => false }, content: '', embeds: [new EmbedBuilder().setTitle('Old').toJSON()], components: [] };
  const old = ui.finishCard(legacy, { status: 'Done', color: C.Red });
  assert.equal(old.embeds[0].data.footer.text, 'Done');
});

test('emojis typed by staff are checked before they reach a button or menu', () => {
  const { toEmoji } = require('../src/util');
  assert.deepEqual(toEmoji('🎫'), { name: '🎫' });
  assert.deepEqual(toEmoji('🇪🇺'), { name: '🇪🇺' });
  assert.deepEqual(toEmoji('<:rejs:123456789012345678>'), { id: '123456789012345678', name: 'rejs', animated: false });
  assert.deepEqual(toEmoji('<a:party:123456789012345678>').animated, true);
  for (const bad of [':smile:', 'abc', '', null]) assert.equal(toEmoji(bad), null, String(bad));
  const tickets = require('../src/tickets');
  const rows = tickets.panelRows([{ id: 'a', label: 'Support', emoji: '🛠️' }, { id: 'b', label: 'Bad', emoji: ':x:' }]);
  const json = rows[0].toJSON().components;
  assert.equal(json[0].emoji.name, '🛠️');
  assert.equal(json[1].emoji, undefined);
});
