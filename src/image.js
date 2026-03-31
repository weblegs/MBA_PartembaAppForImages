'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const axios = require('axios');
const { logError } = require('./logger');

/**
 * Check if an image buffer has any transparent pixels (alpha < 255).
 */
async function hasTransparency(inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/**
 * Remove near-white background by making those pixels transparent.
 * Thresholds match Python's _remove_background_simple:
 *   - alpha == 0: keep as-is
 *   - r>=245 && g>=245 && b>=245: make transparent
 *   - r>=235 && g>=235 && b>=235: make transparent
 *   - else: keep original
 */
async function removeBackgroundSimple(inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4;
    const a = data[off + 3];
    if (a === 0) continue;
    const r = data[off];
    const g = data[off + 1];
    const b = data[off + 2];
    if ((r >= 245 && g >= 245 && b >= 245) || (r >= 235 && g >= 235 && b >= 235)) {
      data[off + 3] = 0;
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toBuffer();
}

/**
 * Crop image to the bounding box of non-transparent pixels.
 * Mirrors Python's crop_to_content.
 */
async function cropToContent(inputBuffer) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const alpha = data[(y * info.width + x) * 4 + 3];
      if (alpha !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) return inputBuffer; // fully transparent

  return sharp(inputBuffer)
    .extract({
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .toBuffer();
}

/**
 * Place image on a canvas of given size with margin, centering the image.
 * Mirrors Python's place_on_canvas with the exact same landscape/portrait logic.
 */
async function placeOnCanvas(inputBuffer, canvasWidth, canvasHeight, margin = 30) {
  const meta = await sharp(inputBuffer).metadata();
  const w = meta.width;
  const h = meta.height;
  const cw = canvasWidth;
  const ch = canvasHeight;

  let sideMarg = margin;
  let topMarg = margin;
  let maxW, maxH;

  if (w > h) {
    // Landscape: width-driving
    const aspect = h / w;
    maxW = cw - 2 * sideMarg;
    maxH = maxW * aspect;
    topMarg = Math.min(topMarg, (ch - maxH) / 2.0);
    sideMarg = Math.max(sideMarg, (cw - maxW) / 2.0);
  } else {
    // Portrait: height-driving
    const aspect = w / h;
    maxH = ch - 2 * topMarg;
    maxW = maxH * aspect;
    topMarg = Math.min(topMarg, (ch - maxH) / 2.0);
    sideMarg = Math.max(sideMarg, (cw - maxW) / 2.0);

    // Enforce minimum 300px side margin for very tall images
    const horizMarg = (cw - maxW) / 2.0;
    if (horizMarg < 0 || horizMarg < 300) {
      sideMarg = 300.0;
      maxW = cw - 2 * sideMarg;
      maxH = maxW / aspect;
      topMarg = Math.min(topMarg, (ch - maxH) / 2.0);
      sideMarg = Math.max(sideMarg, (cw - maxW) / 2.0);
    }
  }

  const newW = Math.max(1, Math.min(cw, Math.round(maxW)));
  const newH = Math.max(1, Math.min(ch, Math.round(maxH)));

  const resized = await sharp(inputBuffer)
    .resize(newW, newH, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .toBuffer();

  const availW = cw - 2 * sideMarg;
  const x = Math.max(0, Math.min(cw - newW, Math.round(sideMarg + (availW - newW) / 2.0)));
  const y = Math.max(0, Math.min(ch - newH, Math.round(topMarg)));

  return sharp({
    create: {
      width: cw,
      height: ch,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, left: x, top: y, blend: 'over' }])
    .png()
    .toBuffer();
}

/**
 * Compress a PNG file on disk to be under targetBytes.
 * Tries compression levels 9, 6, 3 in order.
 */
async function compressPngUnderSize(filePath, targetBytes = 25 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= targetBytes) return;

    const buf = fs.readFileSync(filePath);
    for (const level of [9, 6, 3]) {
      const compressed = await sharp(buf).png({ compressionLevel: level }).toBuffer();
      if (compressed.length <= targetBytes || level === 3) {
        fs.writeFileSync(filePath, compressed);
        return;
      }
    }
  } catch (ex) {
    await logError(`Failed to compress PNG '${filePath}': ${ex}`);
  }
}

/**
 * Canvas size rules (from Python constants):
 *   Non-HOOD + valid adult size + NOT GIR/WOM → 4675 x 5880
 *   Non-HOOD fallback                         → 3518 x 4404
 *   HOOD + valid adult size + NOT GIR/WOM     → 4770 x 3896
 *   HOOD fallback                             → 4770 x 2951
 */
const VALID_SIZES = new Set(['M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL']);
const VALID_GENDER_EXCLUDE = new Set(['GIR', 'WOM']);

function _getCanvasSize(type, size, gender) {
  const typU = (type || '').toUpperCase();
  const sizeU = (size || '').toUpperCase();
  const genderU = (gender || '').toUpperCase();
  const isAdult = VALID_SIZES.has(sizeU) && !VALID_GENDER_EXCLUDE.has(genderU);

  if (typU !== 'HOOD') {
    return isAdult ? [4675, 5880] : [3518, 4404];
  } else {
    return isAdult ? [4770, 3896] : [4770, 2951];
  }
}

/**
 * Full image processing pipeline for a single workRow.
 * Downloads image from Box URL, processes it, saves to finalDir, returns PNG buffer.
 * Returns null if the file already exists or on error.
 */
async function processImage(row, finalDir, { uploadToR2 }) {
  const hasBuffer = row['_imageBuffer'] instanceof Buffer;
  const url = (row['Image Link'] || '').trim();
  if (!hasBuffer && !url) return null;

  const bil = (row.Bilcode || '').trim();
  const gender = (row.Gender || '').trim();
  const type = (row.Type || '').trim();
  const color = (row.Color || '').trim();
  const size = (row.Size || '').trim();

  const bilOnly = bil.includes('_') ? bil.split('_')[0] : bil;
  const dynamicName = `${bilOnly}-${gender.toUpperCase()}-${type.toUpperCase()}-${color.toUpperCase()}-${size.toUpperCase()}.png`;
  const dynamicPath = path.join(finalDir, dynamicName);

  // Skip if already processed
  if (fs.existsSync(dynamicPath)) return null;

  // 1. Get image bytes (from pre-downloaded buffer or HTTP URL)
  let imgBuffer;
  if (hasBuffer) {
    imgBuffer = row['_imageBuffer'];
  } else {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    imgBuffer = Buffer.from(response.data);
  }

  // 2. Remove background if not already transparent
  const transparent = await hasTransparency(imgBuffer);
  if (!transparent) {
    imgBuffer = await removeBackgroundSimple(imgBuffer);
  }

  // 3. Crop to content
  const cropped = await cropToContent(imgBuffer);

  // 4. Place on canvas
  const [canvasW, canvasH] = _getCanvasSize(type, size, gender);
  const canvas = await placeOnCanvas(cropped, canvasW, canvasH, 30);

  // 5. License text is empty - no-op (drawLicenseTextCentered with empty string)

  // 6. Save to disk then compress
  fs.mkdirSync(path.dirname(dynamicPath), { recursive: true });
  fs.writeFileSync(dynamicPath, canvas);
  await compressPngUnderSize(dynamicPath, 25 * 1024 * 1024);

  // Read compressed bytes for R2 upload
  const pngBytes = fs.readFileSync(dynamicPath);

  // 7. Upload to R2
  const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const r2Key = `${datePrefix}/png/${dynamicName}`;
  await uploadToR2(r2Key, pngBytes, 'image/png');

  return pngBytes;
}

module.exports = {
  hasTransparency,
  removeBackgroundSimple,
  cropToContent,
  placeOnCanvas,
  compressPngUnderSize,
  processImage,
};
