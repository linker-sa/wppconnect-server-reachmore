/*
 * Copyright 2023 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  CreateBucketCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import api from 'axios';
import Crypto from 'crypto';
import { Request } from 'express';
import fs from 'fs';
import mimetypes from 'mime-types';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import config from '../config';
import { convert } from '../mapper/index';
import { ServerOptions } from '../types/ServerOptions';
import { bucketAlreadyExists } from './bucketAlreadyExists';

let mime: any, crypto: any; //, aws: any;
if (config.webhook.uploadS3) {
  mime = config.webhook.uploadS3 ? mimetypes : null;
  crypto = config.webhook.uploadS3 ? Crypto : null;
}
if (config?.websocket?.uploadS3) {
  mime = config.websocket.uploadS3 ? mimetypes : null;
  crypto = config.websocket.uploadS3 ? Crypto : null;
}

// Identifier suffixes the server is able to produce. A suffix supplied by the
// caller is authoritative: WhatsApp already resolves LID identifiers, so
// dropping it and re-deriving the domain rewrites them as phone numbers.
const CONTACT_DOMAINS = ['c.us', 'g.us', 'lid', 'newsletter'];

/**
 * Splits an identifier into its local part and, when recognized, its domain.
 */
function splitContact(contact: string) {
  const [local, domain] = contact.split('@');
  return { local, domain: CONTACT_DOMAINS.includes(domain) ? domain : '' };
}

export function contactToArray(
  number: any,
  isGroup?: boolean,
  isNewsletter?: boolean,
  isLid?: boolean
) {
  const localArr: any = [];
  const arrContacts = Array.isArray(number)
    ? number
    : number.split(/\s*[,;]\s*/g);

  for (const contact of arrContacts) {
    const { local, domain } = splitContact(contact);
    // Group and newsletter identifiers are numeric-only; other contacts also
    // accept formatted numbers such as "+55 (11) 99999-9999".
    const normalized =
      isGroup || isNewsletter ? local : local?.replace(/[^\w ]/g, '');
    if (normalized !== '') {
      // An explicit flag wins, then a suffix the caller already provided, and
      // only then the length heuristic that guesses LID from a bare number.
      const suffix = isGroup
        ? 'g.us'
        : isNewsletter
        ? 'newsletter'
        : isLid
        ? 'lid'
        : // Fork: 14 digits is already a LID (a 2026-07 fix of ours; upstream says > 14).
          domain || (normalized.length >= 14 ? 'lid' : 'c.us');
      localArr.push(`${normalized}@${suffix}`);
    }
  }

  return localArr;
}

export function groupToArray(group: any) {
  const localArr: any = [];
  if (Array.isArray(group)) {
    for (let contact of group) {
      contact = contact.split('@')[0];
      if (contact !== '') (localArr as any).push(`${contact}@g.us`);
    }
  } else {
    const arrContacts = group.split(/\s*[,;]\s*/g);
    for (let contact of arrContacts) {
      contact = contact.split('@')[0];
      if (contact !== '') (localArr as any).push(`${contact}@g.us`);
    }
  }

  return localArr;
}

export function groupNameToArray(group: any) {
  const localArr: any = [];
  if (Array.isArray(group)) {
    for (const contact of group) {
      if (contact !== '') (localArr as any).push(`${contact}`);
    }
  } else {
    const arrContacts = group.split(/\s*[,;]\s*/g);
    for (const contact of arrContacts) {
      if (contact !== '') (localArr as any).push(`${contact}`);
    }
  }

  return localArr;
}

/**
 * Deliver one webhook, retrying failures that are worth retrying.
 *
 * This used to be a bare `api.post(...).catch(log)` — fire-and-forget. A single
 * failed POST meant the message was gone for good: wppconnect never redelivers,
 * nothing is queued, and the only trace was one warn line. A cold start on the
 * receiver, a transient 5xx or a network blip silently cost a real customer
 * message, which is impossible to diagnose after the fact because the receiving
 * side has no record that anything was ever sent.
 *
 * Retried: no response at all (connection reset, timeout, DNS), 429, and 5xx.
 * NOT retried: other 4xx. Those are deterministic rejections — a 403 from
 * webhook authentication will fail identically every time, so hammering it adds
 * load without saving the message. Those surface as an error instead.
 *
 * Runs detached from the caller (nothing awaits callWebHook), so the backoff
 * never delays event handling.
 *
 * @param {any} webhook Destination URL.
 * @param {any} data Event payload.
 * @param {Request} req Express request, used for its logger.
 * @return {Promise<boolean>} True when the webhook was accepted.
 */
export async function postWebhookWithRetry(
  webhook: any,
  data: any,
  req: Request
): Promise<boolean> {
  const MAX_ATTEMPTS = 5;
  const session = data?.session ?? null;
  const event = data?.event ?? null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await api.post(webhook, data);
      if (attempt > 1)
        req.logger.info(
          `Webhook delivered on attempt ${attempt} (event=${event} session=${session}).`
        );
      return true;
    } catch (e: any) {
      const status = e?.response?.status;
      const retryable = status === undefined || status === 429 || status >= 500;

      if (!retryable) {
        req.logger.error(
          `Webhook REJECTED with ${status} — not retrying, message dropped ` +
            `(event=${event} session=${session}).`
        );
        return false;
      }
      if (attempt === MAX_ATTEMPTS) {
        // The last line before a message is lost for good. Logged at error so
        // it is findable, and carries the identifiers needed to chase it.
        req.logger.error(
          `Webhook FAILED after ${MAX_ATTEMPTS} attempts — message lost ` +
            `(event=${event} session=${session} status=${
              status ?? 'no-response'
            }).`
        );
        return false;
      }
      // Exponential backoff with jitter, so a receiver that is restarting is not
      // hit by every in-flight event at the same instant.
      const delay = 2 ** (attempt - 1) * 500 + Math.floor(Math.random() * 250);
      req.logger.warn(
        `Error calling Webhook (attempt ${attempt}/${MAX_ATTEMPTS}, ` +
          `status=${status ?? 'no-response'}) — retrying in ${delay}ms.`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return false;
}

export async function callWebHook(
  client: any,
  req: Request,
  event: any,
  data: any
) {
  const requestedWebhook = client?.config.webhook;
  const configured = req.serverOptions.webhook;
  // Fork: the allowlist applies only once WEBHOOK_ALLOWED_URLS is set. Our
  // backend registers a URL per session and prod's carries its auth token in
  // the query (?qrToken=), so an exact-match list would have to repeat it.
  // When set, a session can select only destinations the operator configured.
  const enforceAllowlist = (configured.allowedUrls || []).length > 0;
  const webhook = !requestedWebhook
    ? configured.url
    : !enforceAllowlist
    ? requestedWebhook
    : [configured.url, ...(configured.allowedUrls || [])].find(
        (url) => url === requestedWebhook
      );
  if (requestedWebhook && !webhook) {
    req.logger.warn('Session webhook URL is not in the configured allowlist.');
    return;
  }
  if (webhook) {
    if (
      req.serverOptions.webhook?.ignore &&
      (req.serverOptions.webhook.ignore.includes(event) ||
        req.serverOptions.webhook.ignore.includes(data?.from) ||
        req.serverOptions.webhook.ignore.includes(data?.type))
    )
      return;
    if (req.serverOptions.webhook.autoDownload)
      await autoDownload(client, req, data);
    try {
      const chatId =
        data.from ||
        data.chatId ||
        (data.chatId ? data.chatId._serialized : null);
      data = Object.assign({ event: event, session: client.session }, data);
      if (req.serverOptions.mapper.enable)
        data = await convert(req.serverOptions.mapper.prefix, data);
      // Deliberately not awaited: delivery (and its backoff) must not hold up
      // the event handler. `sendSeen` still runs only on a real success.
      postWebhookWithRetry(webhook, data, req).then((delivered) => {
        if (!delivered) return;
        const events = ['unreadmessages', 'onmessage'];
        if (events.includes(event) && req.serverOptions.webhook.readMessage)
          Promise.resolve(client.sendSeen(chatId)).catch((error: unknown) =>
            req.logger.warn('Error marking webhook message as read.', error)
          );
      });
    } catch (e) {
      req.logger.error(e);
    }
  }
}

export async function autoDownload(client: any, req: any, message: any) {
  try {
    if (message && (message['mimetype'] || message.isMedia || message.isMMS)) {
      const uploadS3 =
        req.serverOptions.webhook.uploadS3 ||
        req.serverOptions?.websocket?.uploadS3;
      // Inlined base64 grows the payload ~33% over the file size, so large
      // media can exceed the receiver's body limit and the event is lost.
      const maxSize = req.serverOptions?.webhook?.autoDownloadMaxSize;
      if (!uploadS3 && maxSize > 0 && message.size > maxSize) {
        message.autoDownloadSkipped = true;
        return;
      }
      const buffer = await client.decryptFile(message);
      if (uploadS3) {
        const hashName = crypto.randomBytes(24).toString('hex');

        if (
          !config?.aws_s3?.region ||
          !config?.aws_s3?.access_key_id ||
          !config?.aws_s3?.secret_key
        )
          throw new Error('Please, configure your aws configs');
        const s3Client = new S3Client({
          region: config?.aws_s3?.region,
          endpoint: config?.aws_s3?.endpoint || undefined,
          forcePathStyle: config?.aws_s3?.forcePathStyle || undefined,
        });
        let bucketName = config?.aws_s3?.defaultBucketName
          ? config?.aws_s3?.defaultBucketName
          : client.session;
        bucketName = bucketName
          .normalize('NFD')
          .replace(/[\u0300-\u036f]|[— _.,?!]/g, '')
          .toLowerCase();
        bucketName =
          bucketName.length < 3
            ? bucketName +
              `${Math.floor(Math.random() * (999 - 100 + 1)) + 100}`
            : bucketName;
        const fileName = `${
          config.aws_s3.defaultBucketName ? client.session + '/' : ''
        }${hashName}.${mime.extension(message.mimetype)}`;

        if (
          !config.aws_s3.defaultBucketName &&
          !(await bucketAlreadyExists(bucketName))
        ) {
          await s3Client.send(
            new CreateBucketCommand({
              Bucket: bucketName,
              ObjectOwnership: 'ObjectWriter',
            })
          );
          await s3Client.send(
            new PutPublicAccessBlockCommand({
              Bucket: bucketName,
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: false,
                IgnorePublicAcls: false,
                BlockPublicPolicy: false,
              },
            })
          );
        }

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: fileName,
            Body: buffer,
            ContentType: message.mimetype,
            ACL: 'public-read',
          })
        );

        message.fileUrl = `https://${bucketName}.s3.amazonaws.com/${fileName}`;
      } else {
        message.body = await buffer.toString('base64');
      }
    }
  } catch (e) {
    req.logger.error(e);
  }
}

export async function startAllSessions(config: any, logger: any) {
  try {
    await api.post(`${config.host}:${config.port}/api/-/start-all`, null, {
      headers: { 'x-secret-key': config.secretKey },
    });
  } catch (e) {
    // Not the error object: it carries the request headers, secret included.
    logger.error(`start-all failed: ${(e as Error).message}`);
  }
}

export async function startHelper(client: any, req: any) {
  if (req.serverOptions.webhook.allUnreadOnStart) await sendUnread(client, req);

  if (req.serverOptions.archive.enable) await archive(client, req);
}

async function sendUnread(client: any, req: any) {
  req.logger.info(`${client.session} : Inicio enviar mensagens não lidas`);

  try {
    const chats = await client.getAllChatsWithMessages(true);

    if (chats && chats.length > 0) {
      for (let i = 0; i < chats.length; i++)
        for (let j = 0; j < chats[i].msgs.length; j++) {
          callWebHook(client, req, 'unreadmessages', chats[i].msgs[j]);
        }
    }

    req.logger.info(`${client.session} : Fim enviar mensagens não lidas`);
  } catch (ex) {
    req.logger.error(ex);
  }
}

async function archive(client: any, req: any) {
  async function sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time * 10));
  }

  req.logger.info(`${client.session} : Inicio arquivando chats`);

  try {
    let chats = await client.getAllChats();
    if (chats && Array.isArray(chats) && chats.length > 0) {
      chats = chats.filter((c) => !c.archive);
    }
    if (chats && Array.isArray(chats) && chats.length > 0) {
      for (let i = 0; i < chats.length; i++) {
        const date = new Date(chats[i].t * 1000);

        if (DaysBetween(date) > req.serverOptions.archive.daysToArchive) {
          await client.archiveChat(
            chats[i].id.id || chats[i].id._serialized,
            true
          );
          await sleep(
            Math.floor(Math.random() * req.serverOptions.archive.waitTime + 1)
          );
        }
      }
    }
    req.logger.info(`${client.session} : Fim arquivando chats`);
  } catch (ex) {
    req.logger.error(ex);
  }
}

function DaysBetween(StartDate: Date) {
  const endDate = new Date();
  // The number of milliseconds in all UTC days (no DST)
  const oneDay = 1000 * 60 * 60 * 24;

  // A day in UTC always lasts 24 hours (unlike in other time formats)
  const start = Date.UTC(
    endDate.getFullYear(),
    endDate.getMonth(),
    endDate.getDate()
  );
  const end = Date.UTC(
    StartDate.getFullYear(),
    StartDate.getMonth(),
    StartDate.getDate()
  );

  // so it's safe to divide by 24 hours
  return (start - end) / oneDay;
}

export function createFolders() {
  const __dirname = path.resolve(path.dirname(''));
  const dirFiles = path.resolve(__dirname, 'WhatsAppImages');
  if (!fs.existsSync(dirFiles)) {
    fs.mkdirSync(dirFiles);
  }

  const dirUpload = path.resolve(__dirname, 'uploads');
  if (!fs.existsSync(dirUpload)) {
    fs.mkdirSync(dirUpload);
  }
}

export function strToBool(s: string) {
  return /^(true|1)$/i.test(s);
}

export function getIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface: any = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (
        alias.family === 'IPv4' &&
        alias.address !== '127.0.0.1' &&
        !alias.internal
      )
        return alias.address;
    }
  }
  return '0.0.0.0';
}

export function setMaxListners(serverOptions: ServerOptions) {
  if (serverOptions && Number.isInteger(serverOptions.maxListeners)) {
    process.setMaxListeners(serverOptions.maxListeners);
  }
}

export const unlinkAsync = promisify(fs.unlink);

export function createCatalogLink(session: any) {
  const [wid] = session.split('@');
  return `https://wa.me/c/${wid}`;
}
