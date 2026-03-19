'use strict';

const path = require('path');
const fs = require('fs');
const SftpClient = require('ssh2-sftp-client');
const { log, logError } = require('./logger');

/**
 * Ensure a remote directory exists by creating each path segment.
 */
async function _ensureRemoteDir(sftp, remoteDir) {
  const parts = remoteDir.replace(/\\/g, '/').split('/').filter(Boolean);
  let current = '';
  for (const p of parts) {
    current = current ? `${current}/${p}` : `/${p}`;
    try {
      await sftp.stat(current);
    } catch {
      try {
        await sftp.mkdir(current);
      } catch {
        // May already exist in a race; ignore
      }
    }
  }
}

/**
 * Download all .csv files from orderFolder to localFolder,
 * then move them to processedFolder on the remote server.
 * Returns an array of local file paths (strings).
 */
async function downloadCsvsAndMoveToProcessed({
  host, port, username, password,
  orderFolder, processedFolder, localFolder,
}) {
  const downloaded = [];
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host, port, username, password });

    const entries = await sftp.list(orderFolder);
    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith('.csv')) continue;

      const remotePath = `${orderFolder.replace(/\/$/, '')}/${entry.name}`;
      const localPath = path.join(localFolder, entry.name);

      await sftp.fastGet(remotePath, localPath);
      downloaded.push(localPath);

      const remoteProcessed = `${processedFolder.replace(/\/$/, '')}/${entry.name}`;
      try {
        await sftp.rename(remotePath, remoteProcessed);
        await log(`Successfully moved file to processed folder: ${remoteProcessed}`);
      } catch (ex) {
        await logError(`Error moving file to processed folder: ${remoteProcessed}. Error: ${ex}`);
      }
    }
  } finally {
    await sftp.end().catch(() => {});
  }
  return downloaded;
}

/**
 * Upload a local file to SFTP with up to 3 retries.
 * On all retries failing, sends a notification email.
 */
async function uploadFile({ localFilePath, sftpDirectory, host, port, username, password }) {
  const maxRetries = 3;
  let lastError = null;
  const fileName = path.basename(localFilePath);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host, port, username, password });
      await _ensureRemoteDir(sftp, sftpDirectory);
      const remotePath = `${sftpDirectory.replace(/\/$/, '')}/${fileName}`;
      await sftp.fastPut(localFilePath, remotePath);
      await logError(
        `File '${fileName}' uploaded successfully to SFTP (attempt ${attempt}/${maxRetries}).`
      );
      return;
    } catch (ex) {
      lastError = ex;
      await logError(
        `Error during SFTP upload of '${fileName}' (attempt ${attempt}/${maxRetries}): ${ex}`
      );
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  // All retries failed – send a notification email
  try {
    const { sendMail } = require('./gmail');
    const body = `
<html>
<body>
<p>Hi,</p>
<p>The application tried ${maxRetries} times but could not upload file
<b>${fileName}</b> to SFTP directory <b>${sftpDirectory}</b>.</p>
<p>Last error message:<br/>
${lastError}</p>
<p>Please investigate the SFTP server or network connectivity.</p>
<p>Regards,<br/>
Weblegs Support Team</p>
</body>
</html>
`;
    await sendMail(body, localFilePath);
  } catch (ex) {
    await logError(`Failed to send SFTP failure notification email: ${ex}`);
  }
}

/**
 * Upload CSV bytes (Buffer) directly to SFTP without writing a local file.
 * Up to 3 retries.
 */
async function uploadCsvBytesToSftp({
  csvBuffer, remoteName, sftpDirectory,
  host, port, username, password,
}) {
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host, port, username, password });
      await _ensureRemoteDir(sftp, sftpDirectory);
      const remotePath = `${sftpDirectory.replace(/\/$/, '')}/${remoteName}`;
      await sftp.put(csvBuffer, remotePath);
      await logError(
        `CSV '${remoteName}' uploaded successfully to SFTP (attempt ${attempt}/${maxRetries}).`
      );
      return;
    } catch (ex) {
      lastError = ex;
      await logError(
        `Error during SFTP CSV upload of '${remoteName}' (attempt ${attempt}/${maxRetries}): ${ex}`
      );
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  // All retries failed
  try {
    const { sendMail } = require('./gmail');
    const body = `
<html>
<body>
<p>Hi,</p>
<p>The application tried ${maxRetries} times but could not upload CSV
<b>${remoteName}</b> to SFTP directory <b>${sftpDirectory}</b>.</p>
<p>Last error message:<br/>
${lastError}</p>
<p>Please investigate the SFTP server or network connectivity.</p>
<p>Regards,<br/>
Weblegs Support Team</p>
</body>
</html>
`;
    await sendMail(body, '');
  } catch (ex) {
    await logError(`Failed to send SFTP CSV failure notification email: ${ex}`);
  }
}

module.exports = {
  downloadCsvsAndMoveToProcessed,
  uploadFile,
  uploadCsvBytesToSftp,
};
