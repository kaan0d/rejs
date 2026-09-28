const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHECK_MS = 60_000;
const exec = promisify(execFile);
// npm is a .cmd script on Windows, which needs a shell; git doesn't.
const run = (cmd, args) => exec(cmd, args, { cwd: ROOT, shell: cmd === 'npm' && process.platform === 'win32' }).then((r) => r.stdout.trim());
const git = (...args) => run('git', args);

const autoRestart = () => process.env.DEV_RESTART === 'true';

// Returns "abc1234 Commit subject" for the newest commit on GitHub, or null when up to date.
async function checkForUpdate() {
  await git('fetch', '--quiet');
  // Count only commits GitHub has that we don't, so local commits never trigger a restart loop.
  const behind = Number(await git('rev-list', '--count', 'HEAD..@{u}'));
  return behind ? git('log', '-1', '--format=%h %s', '@{u}') : null;
}

// Pulls the new code and reinstalls packages when they changed. Returns the new commit line.
async function update() {
  const before = await git('rev-parse', 'HEAD');
  await git('pull', '--ff-only', '--quiet');
  const changed = await git('diff', '--name-only', before, 'HEAD');
  if (/^package(-lock)?\.json$/m.test(changed)) await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
  return git('log', '-1', '--format=%h %s');
}

// pm2 starts the bot again after it exits. The delay lets the last reply reach Discord.
const restart = () => setTimeout(() => process.exit(0), 1000);

function start(client) {
  if (!autoRestart()) return;
  console.log('DEV_RESTART is on: checking GitHub for new commits every minute.');
  setInterval(async () => {
    try {
      if (!(await checkForUpdate())) return;
      const commit = await update();
      console.log(`Updated to ${commit}. Restarting.`);
      await client.notifyOwner(`New push, updated to \`${commit}\`. Restarting.`);
      restart();
    } catch (e) {
      // A failed pull (for example local edits on the server) must not take the bot down.
      console.error('Auto-update failed:', e.message);
    }
  }, CHECK_MS);
}

const currentCommit = () => git('log', '-1', '--format=%h %s').catch(() => 'unknown');

module.exports = { start, checkForUpdate, update, restart, autoRestart, currentCommit };
