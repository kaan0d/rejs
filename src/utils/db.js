const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('server_monitor.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY,
      name TEXT,
      steam TEXT,
      discord TEXT,
      join_date TEXT,
      leave_date TEXT,
      status TEXT
    )
  `);
});

module.exports = db;
