// AWS utilities — S3 document storage (COA, MSDS, complaint photos, invoices)
// and an optional SES email helper. See PRD §3.1 (Storage) and §12 (Integrations).

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

const hasCreds = Boolean(env.aws.accessKeyId && env.aws.secretAccessKey);

/** Whether S3/SES credentials are configured (used to degrade gracefully). */
export const isAwsConfigured = hasCreds;

const clientConfig = {
  region: env.aws.region,
  ...(hasCreds && {
    credentials: {
      accessKeyId: env.aws.accessKeyId,
      secretAccessKey: env.aws.secretAccessKey,
    },
  }),
};

export const s3 = new S3Client(clientConfig);
export const ses = new SESClient(clientConfig);

/**
 * Upload a buffer/stream to S3 and return its key + (optional) public URL.
 * @param {object} opts
 * @param {Buffer|Uint8Array|string} opts.body
 * @param {string} opts.contentType
 * @param {string} [opts.prefix] - folder, e.g. "coa", "complaints", "invoices".
 * @param {string} [opts.filename] - original name (used for extension).
 */
export async function uploadObject({ body, contentType, prefix = 'uploads', filename = '' }) {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()}` : '';
  const key = `${prefix}/${randomUUID()}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: env.aws.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

  const url = env.aws.s3PublicBaseUrl
    ? `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${key}`
    : null;

  return { key, url };
}

/** Generate a time-limited download URL for a private object. */
export function getDownloadUrl(key, expiresInSeconds = 900) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.aws.s3Bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

/** Generate a presigned PUT URL so clients can upload directly to S3. */
export function getUploadUrl(key, contentType, expiresInSeconds = 900) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: env.aws.s3Bucket, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}

export async function deleteObject(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: env.aws.s3Bucket, Key: key }));
}

/** Send a transactional email via SES (invoices, statements, reminders). */
export async function sendEmail({ to, subject, html, text }) {
  if (!env.aws.sesFromEmail) {
    throw new Error('AWS_SES_FROM_EMAIL is not configured');
  }
  await ses.send(
    new SendEmailCommand({
      Source: env.aws.sesFromEmail,
      Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          ...(html && { Html: { Data: html } }),
          ...(text && { Text: { Data: text } }),
        },
      },
    }),
  );
}
