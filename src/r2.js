'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const config = require('./config');
const { log, logError } = require('./logger');

let _s3Client = null;
let _bucket = null;

function _getR2ClientAndBucket() {
  const endpoint = config.get('R2_ENDPOINT');
  const accessKeyId = config.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = config.get('R2_SECRET_ACCESS_KEY');
  const bucket = config.get('R2_BUCKET');

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'Cloudflare R2 is not configured. Please set R2_ENDPOINT, ' +
      'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.'
    );
  }

  if (!_s3Client) {
    _s3Client = new S3Client({
      endpoint,
      region: 'auto',
      credentials: { accessKeyId, secretAccessKey },
    });
    _bucket = bucket;
  }

  return { client: _s3Client, bucket: _bucket };
}

/**
 * Validate R2 config at startup. Throws if misconfigured.
 */
function validateR2Config() {
  _getR2ClientAndBucket();
}

/**
 * Upload a Buffer to Cloudflare R2.
 * Logs success/failure to DB and re-throws on failure.
 */
async function uploadToR2(key, data, contentType) {
  const { client, bucket } = _getR2ClientAndBucket();
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));
    await log(`R2 upload succeeded: bucket=${bucket}, key=${key}, content_type=${contentType}`);
  } catch (ex) {
    await logError(`R2 upload failed for ${key}: ${ex}`);
    throw ex;
  }
}

module.exports = { validateR2Config, uploadToR2 };
