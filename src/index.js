'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const config = require('./config');
const { log, logError, _writeLogToDb } = require('./logger');
const { validateR2Config, uploadToR2 } = require('./r2');
const { downloadCsvsAndMoveToProcessed, uploadFile, uploadCsvBytesToSftp } = require('./sftp');
const { buildJobsFromCsvs, dataframeToCsvBytes } = require('./csv');
const { boxImageFunctionality } = require('./box');
const { processImage } = require('./image');
const { sendMail, sendNotificationEmail } = require('./gmail');

// ----------------------------
// SFTP constants (module-level, mirrors Python globals)
// ----------------------------
const SFTP_HOST = config.get('SFTP_HOST', 'ftp.pertembaglobal.com');
const SFTP_PORT = config.getInt('SFTP_PORT', 22);
const SFTP_USERNAME = config.get('SFTP_USERNAME', '');
const SFTP_PASSWORD = config.get('SFTP_PASSWORD', '');
const SFTP_ORDER_FOLDER = config.get('SFTP_ORDER_FOLDER', '/orders/');
const SFTP_PROCESSED_FOLDER = config.get('SFTP_PROCESSED_FOLDER', '/orders/processed/');
const SFTP_DIRECTORY_CSV = config.get('SFTP_DIRECTORY_CSV', '/uploads/CSV');
const SFTP_DIRECTORY_IMAGES = config.get('SFTP_DIRECTORY_IMAGES', '/uploads/img');

// ----------------------------
// Directory helpers
// ----------------------------

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/**
 * Clean configured output directories before a new run:
 *   - Delete CSV/XLS/XLSX files
 *   - Move image files to backupImagesDirectory (if configured)
 */
function _processConfiguredDirectories() {
  const keys = ['FinalPath', 'OutputFilePath'];
  const dirs = keys.map(k => config.get(k)).filter(Boolean).map(v => path.resolve(v));

  const backupDirRaw = config.get('backupImagesDirectory');
  const backupDir = backupDirRaw ? path.resolve(backupDirRaw) : null;
  if (backupDir) fs.mkdirSync(backupDir, { recursive: true });

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      try {
        const ext = path.extname(file).toLowerCase();
        if (['.csv', '.xls', '.xlsx'].includes(ext)) {
          fs.unlinkSync(filePath);
        } else if (['.jpg', '.jpeg', '.png', '.psd', '.ai'].includes(ext) && backupDir) {
          let dest = path.join(backupDir, file);
          if (fs.existsSync(dest)) {
            const stat = fs.statSync(filePath);
            const base = path.basename(file, ext);
            dest = path.join(backupDir, `${base}_${stat.mtimeMs}${ext}`);
          }
          fs.renameSync(filePath, dest);
        }
      } catch {}
    }
  }
}

/**
 * Remove intermediate working folders after a successful run.
 */
function _cleanupWorkingDirectories() {
  const keys = ['FinalPath', 'outputFilePath'];
  for (const k of keys) {
    const raw = config.get(k);
    if (!raw) continue;
    const p = path.resolve(raw);
    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) fs.unlinkSync(p);
      else if (stat.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    } catch (ex) {
      if (ex.code === 'ENOENT') {
        logError(`No files to clean at '${p}'`).catch(() => {});
      } else {
        logError(`Error cleaning working path '${p}': ${ex}`).catch(() => {});
      }
    }
  }
}

// ----------------------------
// Application 2: Get Box image links for all jobs
// ----------------------------

async function getImageLinksForJobs(jobs) {
  const reportOutputPathRaw = config.get('ReportOutputPath', '');
  const reportOutputPath = reportOutputPathRaw
    ? path.resolve(reportOutputPathRaw)
    : path.join(config.baseDir, 'output', 'reports');
  fs.mkdirSync(reportOutputPath, { recursive: true });

  const userId = config.get('BOX_AS_USER_ID') || config.get('BOX_USER_ID', '');

  for (const job of jobs) {
    for (const row of job.workRows) {
      const bilcode = (row.Bilcode || '').trim();
      const color = (row.Color || '').trim();
      if (!bilcode) continue;

      const res = await boxImageFunctionality({
        searchTerm: bilcode,
        color,
        userId,
      });

      if (res.buffer) {
        const ext = (res.extension || '').toLowerCase();
        if (ext === 'png') row['png file'] = 'Yes';
        if (ext === 'psd') row['psd file'] = 'Yes';
        if (ext === 'ai') row['ai file'] = 'Yes';
        if (ext === 'tif' || ext === 'tiff') row['tif file'] = 'Yes';
        if (res.isPocket) {
          row['_pocketBuffer'] = res.buffer;
          row['Pocket Print'] = 'Yes';
        } else {
          row['_imageBuffer'] = res.buffer;
          row['Image Link'] = 'box-direct';
        }
      }
      if (res.noImageFound) {
        row['No Image Found'] = 'No Image Found';
      }
    }

    // Write a CREATE sheet XLSX for downstream compatibility
    try {
      const csvStem = path.basename(job.csvPath, path.extname(job.csvPath));
      const outPath = path.join(reportOutputPath, `${csvStem}.xlsx`);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('CREATE');

      if (job.workRows.length > 0) {
        const columns = Object.keys(job.workRows[0]);
        sheet.addRow(columns);
        for (const row of job.workRows) {
          sheet.addRow(columns.map(c => row[c] || ''));
        }
      }
      await workbook.xlsx.writeFile(outPath);
    } catch (ex) {
      await logError(`Error writing report XLSX: ${ex}`);
    }
  }
}

// ----------------------------
// Application 3: Download and process images
// ----------------------------

async function downloadImagesForJobs(jobs) {
  const finalDirRaw = config.get('FinalPath', '');
  const finalDir = finalDirRaw
    ? path.resolve(finalDirRaw)
    : path.join(config.baseDir, 'output', 'images');
  fs.mkdirSync(finalDir, { recursive: true });

  for (const job of jobs) {
    for (const row of job.workRows) {
      const url = (row['Image Link'] || '').trim();
      if (!url) continue;

      try {
        await processImage(row, finalDir, { uploadToR2 });
      } catch (ex) {
        const msg = `Date: ${new Date().toISOString()}\nError in processing file ${job.csvPath}\nMessage: ${ex}\n`;
        await _writeLogToDb('download log', msg);
      }
    }
  }
}

// ----------------------------
// Application 6: Create output CSV and upload
// ----------------------------

async function createCsvAndUpload(jobs) {
  const finalDirRaw = config.get('FinalPath', '');
  const finalDir = finalDirRaw
    ? path.resolve(finalDirRaw)
    : path.join(config.baseDir, 'output', 'images');

  for (const job of jobs) {
    // Copy rawRows and add a 'status' column
    const rows = job.rawRows.map(r => ({ ...r, status: '' }));

    let containsIssue = false;
    const issues = [];

    for (const row of rows) {
      const firstKey = Object.keys(row)[0];
      const inventoryNumber = (row[firstKey] || '').trim();
      if (!inventoryNumber) continue;

      const imagePath = path.join(finalDir, `${inventoryNumber}.png`);
      const exists = fs.existsSync(imagePath);
      row.status = exists ? 'submitted' : 'issue';
      if (!exists) {
        containsIssue = true;
        issues.push(`${inventoryNumber}: images not found`);
      }
    }

    const suffix = containsIssue ? '-processed' : '-completed';
    const csvStem = path.basename(job.csvPath, path.extname(job.csvPath));
    const outName = `${csvStem}${suffix}.csv`;

    // Determine column order: original columns + status
    const originalCols = job.rawRows.length > 0 ? Object.keys(job.rawRows[0]) : [];
    const columns = originalCols.includes('status')
      ? originalCols
      : [...originalCols, 'status'];

    // Serialize and upload CSV to SFTP
    const csvBytes = dataframeToCsvBytes(rows, columns);
    await logError(`CSV ready to upload to SFTP: ${outName}`);

    await uploadCsvBytesToSftp({
      csvBuffer: csvBytes,
      remoteName: outName,
      sftpDirectory: SFTP_DIRECTORY_CSV,
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USERNAME,
      password: SFTP_PASSWORD,
    });

    // Backup CSV to R2
    const datePrefix = new Date().toISOString().slice(0, 10);
    await uploadToR2(`${datePrefix}/csv/${outName}`, csvBytes, 'text/csv');

    // Upload each processed image to SFTP
    for (const row of rows) {
      const firstKey = Object.keys(row).find(k => k !== 'status') || Object.keys(row)[0];
      const inventoryNumber = (row[firstKey] || '').trim();
      if (!inventoryNumber) continue;

      const imagePath = path.join(finalDir, `${inventoryNumber}.png`);
      if (fs.existsSync(imagePath)) {
        await logError(`image ready to upload: ${imagePath}`);
        await uploadFile({
          localFilePath: imagePath,
          sftpDirectory: SFTP_DIRECTORY_IMAGES,
          host: SFTP_HOST,
          port: SFTP_PORT,
          username: SFTP_USERNAME,
          password: SFTP_PASSWORD,
        });
      }
    }

    // Send notification email
    const fileName = path.basename(job.csvPath);
    if (issues.length > 0) {
      const emailBody = `
<html>
<body>
<p>Hi,</p>
<p>Few billcode images in file <b>${fileName}</b> appear to be missing from the Box folder. Could you please verify and upload the missing images at your earliest convenience?</p>
<p>Here are the Billcodes:<br>
${issues.join('<br>')}
</p>
<p>Regards,<br>
Weblegs Support Team</p>
</body>
</html>
`;
      await sendMail(emailBody, outName);
    } else {
      const emailBody = `
<html>
<body>
<p>Hi,</p>
<p>All the billcode images in file <b>${fileName}</b> are completed successfully</p>
<p>Regards,<br>
Weblegs Support Team</p>
</body>
</html>
`;
      await sendMail(emailBody, '');
    }
  }
}

// ----------------------------
// Main orchestration
// ----------------------------

async function run() {
  // Startup: validate R2 configuration
  try {
    validateR2Config();
  } catch (ex) {
    await logError(`Startup configuration error (R2): ${ex}`);
    return;
  }

  await log('Enter in MBA_2024 (Node.js port)');
  _processConfiguredDirectories();

  // Application 1: Download CSVs from SFTP and build jobs
  let jobs = [];
  try {
    await log('Application 1_ExcelConversion start');
    const tempFolder = ensureDir(path.join(config.baseDir, 'Temp'));

    const downloadedCsvs = await downloadCsvsAndMoveToProcessed({
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USERNAME,
      password: SFTP_PASSWORD,
      orderFolder: SFTP_ORDER_FOLDER,
      processedFolder: SFTP_PROCESSED_FOLDER,
      localFolder: tempFolder,
    });

    if (downloadedCsvs.length === 0) {
      const subject = 'No CSV Files Found on SFTP Server';
      const body = `
<html>
<body>
<p>Hello,</p>
<p>The application checked the SFTP server but did not find any CSV files to process.</p>
<p>Please verify the file availability or the folder contents.</p>
<p>Kind regards,<br/>
Weblegs Support Team</p>
</body>
</html>
`;
      await sendNotificationEmail(body, subject, null);
      await log('No CSV files found on SFTP. Notification email sent.');
    }

    jobs = await buildJobsFromCsvs(downloadedCsvs, config.testMode);

    // Clean up temp folder
    try { fs.rmSync(tempFolder, { recursive: true, force: true }); } catch {}
    await log('Application 1_ExcelConversion end');
  } catch (ex) {
    await log(`Application 1 Error: ${ex}\n${ex.stack || ''}\n`);
    return;
  }

  // Application 2: Get Box image links
  try {
    await log('Application 2_AbsoluteImageProcessApp start');
    await getImageLinksForJobs(jobs);
    await log('Application 2_AbsoluteImageProcessApp end');
  } catch (ex) {
    await log(`Application 2 Error: ${ex}\n${ex.stack || ''}\n`);
    return;
  }

  // Application 3: Download and process images
  try {
    await log('Application 3_ImageProcessing start');
    await downloadImagesForJobs(jobs);
    await log('Application 3_ImageProcessing end');
  } catch (ex) {
    await log(`Application 3 Error: ${ex}\n${ex.stack || ''}\n`);
    return;
  }

  // Application 6: Create output CSV and upload
  try {
    await log('Application 6_CreateExcel start');
    await createCsvAndUpload(jobs);
    await log('Application 6_CreateExcel end');
  } catch (ex) {
    await log(`Application 6 Error: ${ex}\n${ex.stack || ''}\n`);
    return;
  }

  // Final cleanup - only reached if all apps succeeded
  try {
    await log('Cleanup working directories start');
    _cleanupWorkingDirectories();
    await log('Cleanup working directories end');
  } catch (ex) {
    await log(`Cleanup Error: ${ex}\n${ex.stack || ''}\n`);
  }
}

// Entry point
if (require.main === module) {
  run().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { run };
