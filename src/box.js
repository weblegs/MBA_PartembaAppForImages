'use strict';

const fs = require('fs');
const path = require('path');
const BoxSDK = require('box-node-sdk');
const { logError } = require('./logger');
const config = require('./config');

/**
 * Load Box JWT config JSON from environment variables or file path (fallback).
 *
 * Priority:
 *   1. BOX_CONFIG                   – full JSON string (e.g. pasted directly in Railway)
 *   2. BOX_CREDENTIALS_JSON_BASE64  – base64-encoded JSON content
 *   3. BOX_CREDENTIALS_JSON_CONTENT – raw JSON string (alternative name)
 *   4. BOX_CREDENTIALS_JSON         – file path (legacy fallback)
 *
 * Returns the parsed config object, or null if nothing is configured.
 */
function _loadBoxConfig() {
  const raw = config.get('BOX_CONFIG');
  if (raw && raw.trim()) {
    return JSON.parse(raw.trim());
  }

  const b64 = config.get('BOX_CREDENTIALS_JSON_BASE64');
  if (b64 && b64.trim()) {
    return JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  }

  const content = config.get('BOX_CREDENTIALS_JSON_CONTENT');
  if (content && content.trim()) {
    return JSON.parse(content.trim());
  }

  const filePath = config.get('BOX_CREDENTIALS_JSON');
  if (filePath && fs.existsSync(filePath.trim())) {
    return JSON.parse(fs.readFileSync(filePath.trim(), 'utf8'));
  }

  return null;
}

/**
 * Find the closest color match in a list of file names.
 * Three-pass matching (mirrors Python's _closest_color_match):
 *   1. Exact word match after splitting on [-_\s.]+
 *   2. Substring match with non-alphanumeric boundary
 *   3. Simple substring containment
 * Returns index into names array, or null if no match.
 */
function _closestColorMatch(names, targetColor) {
  if (!names || !names.length || !targetColor) return null;
  const target = targetColor.toLowerCase().trim();

  function splitWords(s) {
    return new Set(s.toLowerCase().split(/[-_\s.]+/).filter(Boolean));
  }

  // Pass 1: exact word match
  for (let i = 0; i < names.length; i++) {
    if (splitWords(names[i]).has(target)) return i;
  }

  // Pass 2: substring with non-alphanumeric boundary
  for (let i = 0; i < names.length; i++) {
    const lower = names[i].toLowerCase();
    const idx = lower.indexOf(target);
    if (idx < 0) continue;
    const before = idx > 0 ? lower[idx - 1] : ' ';
    const after = idx + target.length < lower.length ? lower[idx + target.length] : ' ';
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return i;
  }

  // Pass 3: simple substring
  for (let i = 0; i < names.length; i++) {
    if (names[i].toLowerCase().includes(target)) return i;
  }

  return null;
}

const POCKET_KEYWORDS = [
  'legging', 'mug', 'phone', 'laptop', 'nightdress',
  'pyjama', 'pj', 'pocket', 'short set', 'bottle', 'cap ', 'tote',
];

/**
 * Search Box for images matching searchTerm and color, then download the file buffer directly.
 * Returns { buffer, extension, isPocket, noImageFound }.
 */
async function boxImageFunctionality({ searchTerm, color, userId }) {
  const noResult = { buffer: null, extension: '', isPocket: false, noImageFound: true };

  try {
    const configJson = _loadBoxConfig();
    if (!configJson) return noResult;

    const sdk = BoxSDK.getPreconfiguredInstance(configJson);
    const client = sdk.getAppAuthClient('enterprise', configJson.enterpriseID);

    const uid = userId && String(userId).trim() && String(userId).trim().toLowerCase() !== 'me'
      ? String(userId).trim() : null;
    if (uid) {
      client.asUser(uid);
    }

    const searchResults = await client.search.query(searchTerm, {
      type: 'file',
      fields: 'id,name,type',
      limit: 200,
    });

    const results = (searchResults && searchResults.entries) ? searchResults.entries : [];
    if (!results.length) return noResult;

    function itemName(x) {
      return (x.name || x.object_name || '');
    }

    // Filter: must contain 'dtg' or 'print' in name
    const filtered = results.filter(r => {
      const n = itemName(r).toLowerCase();
      return n.includes('dtg') || n.includes('print');
    });
    if (!filtered.length) return noResult;

    // Prefer PNGs, fall back to TIF/PSD/AI
    const pngs = filtered.filter(r => itemName(r).toLowerCase().endsWith('.png'));
    const others = filtered.filter(r => /\.(tif|tiff|psd|ai)$/i.test(itemName(r)));
    const images = pngs.length ? pngs : others;
    if (!images.length) return noResult;

    // Color matching
    let chosen = null;
    if (color) {
      chosen = images.find(r => itemName(r).toLowerCase().includes(color.toLowerCase())) || null;
      if (!chosen) {
        const idx = _closestColorMatch(images.map(itemName), color);
        if (idx !== null) chosen = images[idx];
      }
    }
    if (!chosen) chosen = images[0];

    const chosenName = itemName(chosen);
    const lowerName = chosenName.toLowerCase();
    const isPocket = POCKET_KEYWORDS.some(k => lowerName.includes(k));

    const fileId = chosen.id || chosen.object_id;
    if (!fileId) throw new Error(`Box search item missing id: ${JSON.stringify(chosen)}`);

    const extension = path.extname(chosenName).replace(/^\./, '');

    // Download file directly via stream (avoids shared-link permission issues)
    const stream = await client.files.getReadStream(fileId, null);
    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });

    return { buffer, extension, isPocket, noImageFound: false };
  } catch (ex) {
    try {
      const logPath = path.join(config.baseDir, 'Boxlog.txt');
      fs.appendFileSync(logPath, `Box issues   ${ex}\n`, 'utf8');
    } catch {}
    await logError(`Box error: ${ex}`);
    return { buffer: null, extension: '', isPocket: false, noImageFound: true };
  }
}

module.exports = { boxImageFunctionality };
