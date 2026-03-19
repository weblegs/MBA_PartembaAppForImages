'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { logError } = require('./logger');

/**
 * Represents a single CSV order file and its in-memory data.
 * - csvPath: original CSV file path (string)
 * - rawRows: full CSV data as array of objects (all original columns)
 * - workRows: processed rows with keys: Bilcode, Gender, Type, Color, Size
 *             (plus Box-enriched columns added later)
 */
class Job {
  constructor({ csvPath, rawRows, workRows }) {
    this.csvPath = csvPath;
    this.rawRows = rawRows;
    this.workRows = workRows;
  }
}

/**
 * Read each CSV into memory and build jobs with a minimal workRows array.
 * Inventory format: Bilcode-Gender-Type-Color-Size (5 dash-separated parts).
 */
async function buildJobsFromCsvs(csvPaths, isTestMode) {
  const jobs = [];

  for (const csvFilePath of csvPaths) {
    let rawRows;
    try {
      const content = fs.readFileSync(csvFilePath, 'utf8');
      rawRows = parse(content, {
        columns: true,
        skip_empty_lines: true,
        cast: false, // all values as strings
        relax_column_count: true,
      });
    } catch (ex) {
      await logError(`Error reading CSV '${csvFilePath}': ${ex}`);
      continue;
    }

    if (!rawRows || rawRows.length === 0) {
      await logError(`CSV '${csvFilePath}' is empty.`);
      continue;
    }

    const rowsToProcess = isTestMode ? Math.min(20, rawRows.length) : rawRows.length;
    const workRows = [];

    for (let i = 0; i < rowsToProcess; i++) {
      const row = rawRows[i];
      // First column value is the inventory code
      const firstKey = Object.keys(row)[0];
      let inv = (row[firstKey] || '').trim();
      if (!inv) continue;

      const parts = inv.split('-');
      if (parts.length === 5) {
        workRows.push({
          Bilcode: parts[0].trim(),
          Gender: parts[1].trim(),
          Type: parts[2].trim(),
          Color: parts[3].trim(),
          Size: parts[4].trim(),
          // Box-enriched columns (populated later)
          'ai file': '',
          'png file': '',
          'psd file': '',
          'tif file': '',
          'Image Link': '',
          'Pocket Print': '',
          'No Image Found': '',
        });
      } else {
        await logError(`File format mismatch detected for inventory value: ${inv}`);
      }
    }

    if (workRows.length === 0) {
      await logError(`No valid rows found in CSV '${csvFilePath}'.`);
      continue;
    }

    jobs.push(new Job({ csvPath: csvFilePath, rawRows, workRows }));
  }

  return jobs;
}

/**
 * Serialize rows to CSV bytes, replacing commas in values with a space.
 * Returns a Buffer.
 */
function dataframeToCsvBytes(rows, columns) {
  if (!rows || rows.length === 0) {
    return Buffer.from(columns.join(',') + '\n', 'utf8');
  }

  // Sanitize values: replace commas with space
  const sanitized = rows.map(row => {
    const r = {};
    for (const col of columns) {
      const val = row[col] !== undefined ? String(row[col]) : '';
      r[col] = val.replace(/,/g, ' ');
    }
    return r;
  });

  const csv = stringify(sanitized, { header: true, columns });
  return Buffer.from(csv, 'utf8');
}

/**
 * Save rows to a CSV file on disk.
 */
function saveToCsv(filePath, rows, columns) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = dataframeToCsvBytes(rows, columns);
  fs.writeFileSync(filePath, buf);
}

module.exports = { Job, buildJobsFromCsvs, dataframeToCsvBytes, saveToCsv };
