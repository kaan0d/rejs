// Daily copies of the database, so a broken disk or a bad update doesn't lose every case and setting.
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');

const KEEP = 7;
const dir = () => path.resolve(process.env.BACKUP_DIR ?? 'backups');
const fileFor = (date) => path.join(dir(), `rejs-${date.toISOString().slice(0, 10)}.db`);

function list() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir())
    .filter((f) => /^rejs-\d{4}-\d{2}-\d{2}(-\d+)?\.db$/.test(f))
    .sort()
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir(), f)).size }));
}

// VACUUM INTO writes a clean, consistent copy even while the bot keeps writing.
function backup(now = new Date(), { force = false } = {}) {
  if (process.env.DB_PATH === ':memory:') return null;
  fs.mkdirSync(dir(), { recursive: true });
  let file = fileFor(now);
  if (fs.existsSync(file)) {
    if (!force) return null;
    file = file.replace(/\.db$/, `-${now.getTime()}.db`);
  }
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  for (const old of list().slice(0, -KEEP)) fs.rmSync(path.join(dir(), old.name));
  return { file, size: fs.statSync(file).size };
}

module.exports = { backup, list, dir };
