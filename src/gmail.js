'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { logError } = require('./logger');
const config = require('./config');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

/**
 * Load Gmail OAuth client credentials.
 *
 * Priority:
 *   1. GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env vars
 *   2. GMAIL_CREDENTIALS_JSON file path (legacy fallback)
 *   3. credentials.json next to project root (legacy fallback)
 */
function _loadClientSecrets() {
  const clientId = config.get('GMAIL_CLIENT_ID');
  const clientSecret = config.get('GMAIL_CLIENT_SECRET');
  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }

  // Fallback: read from file
  const credOverride = config.get('GMAIL_CREDENTIALS_JSON');
  const credPath = credOverride
    ? path.resolve(credOverride)
    : path.join(config.baseDir, 'credentials.json');

  if (!fs.existsSync(credPath)) {
    throw new Error(
      'Gmail credentials not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars, ' +
      `or provide a credentials file at: ${credPath}`
    );
  }

  const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const cfg = data.installed || data.web || {};
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error(`client_id/client_secret missing in credentials file: ${credPath}`);
  }
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret };
}

/**
 * Load Gmail OAuth token credentials.
 *
 * Priority:
 *   1. GMAIL_REFRESH_TOKEN + GMAIL_ACCESS_TOKEN env vars
 *   2. GMAIL_TOKEN_PATH file path (legacy C# token file)
 *   3. token.json next to project root (legacy fallback)
 */
function _loadTokenCredentials() {
  const refreshToken = config.get('GMAIL_REFRESH_TOKEN');
  const accessToken = config.get('GMAIL_ACCESS_TOKEN');
  if (refreshToken) {
    return {
      access_token: accessToken || null,
      refresh_token: refreshToken,
      scope: config.get('GMAIL_TOKEN_SCOPE') || SCOPES[0],
      token_type: 'Bearer',
    };
  }

  // Fallback: read from file
  const tokenOverride = config.get('GMAIL_TOKEN_PATH');
  if (tokenOverride) {
    const tokenPath = path.resolve(tokenOverride);
    if (!fs.existsSync(tokenPath)) {
      throw new Error(`Gmail token file not found at: ${tokenPath}`);
    }
    const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    return {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      scope: tokenData.scope || SCOPES[0],
    };
  }

  const tokenPath = path.join(config.baseDir, 'token.json');
  if (fs.existsSync(tokenPath)) {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  }

  return null;
}

/**
 * Build Gmail service using env-var credentials (preferred) or file fallbacks.
 */
async function initializeGmailService() {
  const { clientId, clientSecret } = _loadClientSecrets();
  const auth = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');

  const tokenCreds = _loadTokenCredentials();
  if (!tokenCreds || (!tokenCreds.access_token && !tokenCreds.refresh_token)) {
    throw new Error(
      'No valid Gmail token found. Set GMAIL_REFRESH_TOKEN (and optionally GMAIL_ACCESS_TOKEN) env vars.'
    );
  }

  auth.setCredentials(tokenCreds);

  try {
    const { credentials } = await auth.refreshAccessToken();
    auth.setCredentials(credentials);
  } catch (ex) {
    await logError(`Gmail token refresh failed: ${ex}`);
  }

  return google.gmail({ version: 'v1', auth });
}

/**
 * Build a raw base64url-encoded MIME email message.
 */
async function _createEmailRaw(to, from, subject, bodyHtml, attachmentPath) {
  const mailOptions = {
    from,
    to,
    subject,
    html: bodyHtml,
  };

  if (attachmentPath && fs.existsSync(attachmentPath)) {
    mailOptions.attachments = [{
      filename: path.basename(attachmentPath),
      path: attachmentPath,
    }];
  }

  return new Promise((resolve, reject) => {
    const transport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
    transport.sendMail(mailOptions, (err, info) => {
      if (err) return reject(err);
      const chunks = [];
      info.message.on('data', chunk => chunks.push(chunk));
      info.message.on('end', () => {
        const raw = Buffer.concat(chunks).toString('base64url');
        resolve(raw);
      });
      info.message.on('error', reject);
    });
  });
}

const RECIPIENTS = [
  // 'support@weblegs.co.uk',
  'ramandeep.matrid33789@gmail.com',
  // 'ester.Gomez@brandsin.co.uk',
  // 'jaimie.lowe@brandsin.co.uk',
];
const FROM_ADDRESS = 'support@weblegs.co.uk';

/**
 * Send an email about missing Billcode images.
 * Returns true on success, false on failure.
 */
async function sendMail(bodyHtml, attachmentFilePath) {
  try {
    const service = await initializeGmailService();
    const subject = 'Missing Billcode Images from Box --';
    const attachment = attachmentFilePath || null;

    for (const to of RECIPIENTS) {
      const raw = await _createEmailRaw(to, FROM_ADDRESS, subject, bodyHtml, attachment);
      await service.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
    }
    return true;
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) {
      await logError(`Email sending failed: ${ex}`);
    } else {
      await logError(`Email send error: ${ex}`);
    }
    return false;
  }
}

/**
 * Send a notification email with a custom subject.
 * Returns true on success, false on failure.
 */
async function sendNotificationEmail(bodyHtml, subject, attachmentFilePath) {
  try {
    const service = await initializeGmailService();
    const attachment = attachmentFilePath || null;

    for (const to of RECIPIENTS) {
      const raw = await _createEmailRaw(to, FROM_ADDRESS, subject, bodyHtml, attachment);
      await service.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
    }
    return true;
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) {
      await logError(`Email sending failed: ${ex}`);
    } else {
      await logError(`Notification email send error: ${ex}`);
    }
    return false;
  }
}

module.exports = { sendMail, sendNotificationEmail };
