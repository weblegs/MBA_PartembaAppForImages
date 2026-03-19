'use strict';

const path = require('path');
const fs = require('fs');

// Load .env without overriding existing environment variables
// Mirrors Python's _load_env_file which skips keys already in os.environ
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    val = val.replace(/^['"]|['"]$/g, '');
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

const baseDir = path.resolve(__dirname, '..');

const config = {
  baseDir,

  get(key, defaultVal = undefined) {
    const v = process.env[key];
    return v !== undefined ? v : defaultVal;
  },

  getBool(key, defaultVal = false) {
    const v = process.env[key];
    if (v === undefined) return defaultVal;
    return ['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());
  },

  getInt(key, defaultVal) {
    const v = process.env[key];
    if (v === undefined || v.trim() === '') return defaultVal;
    const n = parseInt(v.trim(), 10);
    return isNaN(n) ? defaultVal : n;
  },

  get testMode() {
    return config.getBool('TestMode', false);
  },
};

module.exports = config;
