const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const db = require('./db');
const moment = require('moment');

function backupDatabase() {
  return new Promise((resolve, reject) => {
    const backupDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir);
    }
    const backupFile = path.join(backupDir, `backup_${moment().format('YYYYMMDD_HHmmss')}.db`);
    const backupDb = new sqlite3.Database(backupFile);

    db.serialize(() => {
      db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
        if (err) {
          reject(err);
        }

        let pendingTables = tables.length;

        tables.forEach(table => {
          const tableName = table.name;
          db.all(`SELECT * FROM ${tableName}`, (err, rows) => {
            if (err) {
              reject(err);
            }

            if (rows.length > 0) {
              const columns = Object.keys(rows[0]).join(', ');
              const placeholders = Object.keys(rows[0]).map(() => '?').join(', ');

              backupDb.serialize(() => {
                backupDb.run(`CREATE TABLE IF NOT EXISTS ${tableName} (${columns})`);
                const stmt = backupDb.prepare(`INSERT INTO ${tableName} VALUES (${placeholders})`);
                rows.forEach(row => {
                  stmt.run(Object.values(row));
                });
                stmt.finalize(() => {
                  pendingTables--;
                  if (pendingTables === 0) {
                    backupDb.close((err) => {
                      if (err) {
                        reject(err);
                      } else {
                        resolve();
                      }
                    });
                  }
                });
              });
            } else {
              pendingTables--;
              if (pendingTables === 0) {
                backupDb.close((err) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve();
                  }
                });
              }
            }
          });
        });
      });
    });
  });
}

function clearDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM players', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

async function initializeDatabase() {
  await backupDatabase();
  await clearDatabase();
}

module.exports = { initializeDatabase };
