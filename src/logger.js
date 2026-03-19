'use strict';

const { Client } = require('pg');
const config = require('./config');

function _getPgConnParams() {
  const host = config.get('DB_HOST');
  const database = config.get('DB_NAME');
  const user = config.get('DB_USER');
  const password = config.get('DB_PASSWORD');
  const port = config.getInt('DB_PORT', 0);
  if (!host || !database || !user || !password || !port) return null;
  return { host, database, user, password, port };
}

async function _ensureMbaLogesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "MBA_Loges" (
      id SERIAL PRIMARY KEY,
      log_type TEXT NOT NULL,
      error TEXT NOT NULL
    )
  `);
}

async function _writeLogToDb(logType, message) {
  try {
    const params = _getPgConnParams();
    if (!params) return;
    const client = new Client(params);
    await client.connect();
    try {
      await _ensureMbaLogesTable(client);
      await client.query(
        'INSERT INTO "MBA_Loges" (log_type, error) VALUES ($1, $2)',
        [logType, message]
      );
    } finally {
      await client.end().catch(() => {});
    }
  } catch {
    // Don't let DB logging break console logging
  }
}

async function log(message) {
  await _writeLogToDb('log', message);
  try { console.log(message); } catch {}
}

async function logError(message) {
  await _writeLogToDb('log error', message);
  try { console.error(message); } catch {}
}

module.exports = { log, logError, _writeLogToDb };
