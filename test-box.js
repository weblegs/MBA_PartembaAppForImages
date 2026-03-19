'use strict';

// Quick Box debug script — run with: node test-box.js <searchTerm>
// Example: node test-box.js ABC123

require('./src/config'); // loads .env
const fs = require('fs');
const BoxSDK = require('box-node-sdk');

const searchTerm = process.argv[2];
if (!searchTerm) {
  console.error('Usage: node test-box.js <searchTerm>');
  process.exit(1);
}

async function main() {
  // --- 1. Load config ---
  let configJson = null;

  const raw = process.env.BOX_CONFIG;
  if (raw && raw.trim()) {
    configJson = JSON.parse(raw.trim());
    console.log('[config] Loaded from BOX_CONFIG env var');
  }

  const b64 = process.env.BOX_CREDENTIALS_JSON_BASE64;
  if (!configJson && b64 && b64.trim()) {
    configJson = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    console.log('[config] Loaded from BOX_CREDENTIALS_JSON_BASE64 env var');
  }

  const filePath = process.env.BOX_CREDENTIALS_JSON;
  if (!configJson && filePath && fs.existsSync(filePath.trim())) {
    configJson = JSON.parse(fs.readFileSync(filePath.trim(), 'utf8'));
    console.log('[config] Loaded from BOX_CREDENTIALS_JSON file:', filePath.trim());
  }

  if (!configJson) {
    console.error('[config] ERROR: No Box config found. Set BOX_CONFIG, BOX_CREDENTIALS_JSON_BASE64, or BOX_CREDENTIALS_JSON in .env');
    process.exit(1);
  }

  console.log('[config] enterpriseID:', configJson.enterpriseID);
  console.log('[config] clientID:', configJson.boxAppSettings?.clientID);

  // --- 2. Create client ---
  const sdk = BoxSDK.getPreconfiguredInstance(configJson);
  const client = sdk.getAppAuthClient('enterprise', configJson.enterpriseID);

  const userId = (process.env.BOX_AS_USER_ID || process.env.BOX_USER_ID || '').trim();
  if (userId && userId.toLowerCase() !== 'me') {
    client.asUser(userId);
    console.log('[client] Acting as user:', userId);
  } else {
    console.log('[client] Acting as enterprise service account (no user ID set)');
  }

  // --- 3. Search ---
  console.log(`\n[search] Querying Box for: "${searchTerm}"`);
  let searchResults;
  try {
    searchResults = await client.search.query(searchTerm, {
      type: 'file',
      fields: 'id,name,type',
      limit: 200,
    });
  } catch (ex) {
    console.error('[search] ERROR:', ex.message || ex);
    process.exit(1);
  }

  const results = (searchResults && searchResults.entries) ? searchResults.entries : [];
  console.log(`[search] Total results: ${results.length}`);

  if (!results.length) {
    console.log('[search] No results found. Check that the JWT app has "Search Content" scope and access to the files.');
    process.exit(0);
  }

  // Show first 10 results
  console.log('\n[search] First results:');
  results.slice(0, 10).forEach((r, i) => console.log(`  [${i}] id=${r.id}  name=${r.name}`));

  // --- 4. Filter dtg/print ---
  const filtered = results.filter(r => {
    const n = (r.name || '').toLowerCase();
    return n.includes('dtg') || n.includes('print');
  });
  console.log(`\n[filter dtg/print] Matches: ${filtered.length}`);
  if (!filtered.length) {
    console.log('[filter dtg/print] No files contain "dtg" or "print" in name.');
    console.log('  All result names:', results.map(r => r.name));
    process.exit(0);
  }

  // --- 5. Extension filter ---
  const pngs = filtered.filter(r => (r.name || '').toLowerCase().endsWith('.png'));
  const others = filtered.filter(r => /\.(tif|tiff|psd|ai)$/i.test(r.name || ''));
  const images = pngs.length ? pngs : others;
  console.log(`[filter ext] PNGs: ${pngs.length}, TIF/PSD/AI: ${others.length}, chosen pool: ${images.length}`);
  if (!images.length) {
    console.log('[filter ext] No PNG/TIF/PSD/AI files. Names:', filtered.map(r => r.name));
    process.exit(0);
  }

  const chosen = images[0];
  console.log(`\n[chosen] id=${chosen.id}  name=${chosen.name}`);

  // --- 6. Try getReadStream ---
  console.log('\n[download] Attempting getReadStream...');
  try {
    const stream = await client.files.getReadStream(chosen.id, null);
    let bytes = 0;
    await new Promise((resolve, reject) => {
      stream.on('data', chunk => { bytes += chunk.length; });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    console.log(`[download] SUCCESS — downloaded ${bytes} bytes`);
  } catch (ex) {
    console.error('[download] ERROR:', ex.message || ex);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
