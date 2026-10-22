/*
 * Copyright 2021 WPPConnect Team
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
 * See the License for the specific language governing permclearSessionissions and
 * limitations under the License.
 */
import { Message, Whatsapp } from '@wppconnect-team/wppconnect';
import { Request, Response } from 'express';
import fs from 'fs';
import mime from 'mime-types';
import path from 'path';
import QRCode from 'qrcode';
import { Logger } from 'winston';

import { version } from '../../package.json';
import config from '../config';
import CreateSessionUtil from '../util/createSessionUtil';
import { callWebHook, contactToArray } from '../util/functions';
import getAllTokens from '../util/getAllTokens';
import { isSessionMaintenanceActive } from '../util/sessionMaintenance';
import { tokenFilePath } from '../util/sessionPaths';
import {
  START_CONCURRENCY,
  START_SLOT_TIMEOUT_MS,
  startWithLimit,
} from '../util/sessionStartQueue';
import { cleanupSession, clientsArray } from '../util/sessionUtil';

const SessionUtil = new CreateSessionUtil();

function rejectStartDuringMaintenance(res: Response): boolean {
  if (!isSessionMaintenanceActive()) return false;
  res.status(503).json({
    status: false,
    message: 'Session backup or restore is in progress. Try again later.',
  });
  return true;
}

async function downloadFileFunction(
  message: Message,
  client: Whatsapp,
  logger: Logger
) {
  try {
    const buffer = await client.decryptFile(message);

    const filename = `./WhatsAppImages/file${message.t}`;
    if (!fs.existsSync(filename)) {
      let result = '';
      if (message.type === 'ptt') {
        result = `${filename}.oga`;
      } else {
        result = `${filename}.${mime.extension(message.mimetype)}`;
      }

      await fs.writeFile(result, buffer, (err) => {
        if (err) {
          logger.error(err);
        }
      });

      return result;
    } else {
      return `${filename}.${mime.extension(message.mimetype)}`;
    }
  } catch (e) {
    logger.error(e);
    logger.warn(
      'Erro ao descriptografar a midia, tentando fazer o download direto...'
    );
    try {
      const buffer = await client.downloadMedia(message);
      const filename = `./WhatsAppImages/file${message.t}`;
      if (!fs.existsSync(filename)) {
        let result = '';
        if (message.type === 'ptt') {
          result = `${filename}.oga`;
        } else {
          result = `${filename}.${mime.extension(message.mimetype)}`;
        }

        await fs.writeFile(result, buffer, (err) => {
          if (err) {
            logger.error(err);
          }
        });

        return result;
      } else {
        return `${filename}.${mime.extension(message.mimetype)}`;
      }
    } catch (e) {
      logger.error(e);
      logger.warn('Não foi possível baixar a mídia...');
    }
  }
}

export async function download(message: any, client: any, logger: any) {
  try {
    const path = await downloadFileFunction(message, client, logger);
    return path?.replace('./', '');
  } catch (e) {
    logger.error(e);
  }
}

/** Guards against two overlapping start-all runs doubling the load. */
let startAllInProgress = false;

export async function startAllSessions(
  req: Request,
  res: Response
): Promise<any> {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.autoBody=false
     #swagger.operationId = 'startAllSessions'
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.parameters["secretkey"] = {
      schema: 'THISISMYSECURECODE'
     }
   */
  const { secretkey } = req.params;
  const { authorization: token } = req.headers;

  let tokenDecrypt = '';

  if (secretkey === undefined) {
    tokenDecrypt = token?.split(' ')[0] ?? '';
  } else {
    tokenDecrypt = secretkey;
  }

  // Check the secret before touching anything. This used to answer 400 and
  // then fall through, so a request with a wrong secret still started every
  // session (and then threw "Cannot set headers after they are sent").
  if (tokenDecrypt !== req.serverOptions.secretKey) {
    return res.status(400).json({
      response: 'error',
      message: 'The token is incorrect',
    });
  }

  if (startAllInProgress) {
    return res.status(409).json({
      status: 'error',
      message: 'Sessions are already being started',
    });
  }

  if (rejectStartDuringMaintenance(res)) return;
  const allSessions: string[] = await getAllTokens(req);
  if (rejectStartDuringMaintenance(res)) return;
  req.logger.info(
    `Starting ${allSessions.length} session(s), ${START_CONCURRENCY} at a time`
  );

  // Not awaited: the queue can take minutes and the caller only needs to know
  // it began. See sessionStartQueue.ts for why sessions are not started at once.
  startAllInProgress = true;
  startWithLimit(
    allSessions,
    (session) => new CreateSessionUtil().opendata(req, session),
    {
      concurrency: START_CONCURRENCY,
      slotTimeoutMs: START_SLOT_TIMEOUT_MS,
      onError: (session, error) =>
        req.logger.error(`[${session}] failed to start: ${error}`),
      onSlotTimeout: (session) =>
        req.logger.warn(
          `[${session}] still starting after ${START_SLOT_TIMEOUT_MS}ms; starting the next session alongside it`
        ),
    }
  )
    .then(() => req.logger.info('All stored sessions have been started'))
    .finally(() => {
      startAllInProgress = false;
    });

  return await res
    .status(201)
    .json({ status: 'success', message: 'Starting all sessions' });
}

export async function showAllSessions(
  req: Request,
  res: Response
): Promise<any> {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.autoBody=false
     #swagger.operationId = 'showAllSessions'
     #swagger.autoQuery=false
     #swagger.autoHeaders=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["secretkey"] = {
      schema: 'THISISMYSECURETOKEN'
     }
   */
  const { secretkey } = req.params;
  const { authorization: token } = req.headers;

  let tokenDecrypt: any = '';

  if (secretkey === undefined) {
    tokenDecrypt = token?.split(' ')[0];
  } else {
    tokenDecrypt = secretkey;
  }

  const arr: any = [];

  // Must return: without it a wrong secret still got the full session list.
  if (tokenDecrypt !== req.serverOptions.secretKey) {
    return res.status(400).json({
      response: false,
      message: 'The token is incorrect',
    });
  }

  Object.keys(clientsArray).forEach((item) => {
    arr.push({ session: item });
  });

  return res.status(200).json({ response: await getAllTokens(req) });
}

export async function startSession(req: Request, res: Response): Promise<any> {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.autoBody=false
     #swagger.operationId = 'startSession'
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.requestBody = {
      required: true,
      "@content": {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              webhook: { type: "string" },
              waitQrCode: { type: "boolean" },
              proxy: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  username: { type: "string" },
                  password: { type: "string" },
                }
              }
            }
          },
          example: {
            webhook: "",
            waitQrCode: false,
            proxy: {
              url: "http://myproxy.com:8080",
              username: "myuser",
              password: "mypassword"
            }
          }
        }
      }
     }
   */
  const session = req.session;
  const { waitQrCode = false } = req.body;

  if (rejectStartDuringMaintenance(res)) return;
  await getSessionState(req, res);
  await SessionUtil.opendata(req, session, waitQrCode ? res : null);
}

export async function closeSession(req: Request, res: Response): Promise<any> {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.operationId = 'closeSession'
     #swagger.autoBody=true
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  const session = req.session;
  try {
    const entry = (clientsArray as any)[session];
    // Already gone: logout-session (which the receiver calls first) removed the
    // entry, or the phone unlinked and the session was dropped. Nothing is
    // left to close, so it is not an error.
    if (!entry || entry.status == null) {
      return await res
        .status(200)
        .json({ status: true, message: 'Session successfully closed' });
    } else {
      await cleanupSession(session, async (client) => {
        if (typeof client?.close === 'function') {
          await client.close();
        }
      });
      req.io.emit('whatsapp-status', false);
      if (req.client)
        callWebHook(req.client, req, 'closesession', {
          message: `Session: ${session} disconnected`,
          connected: false,
        });

      return await res
        .status(200)
        .json({ status: true, message: 'Session successfully closed' });
    }
  } catch (error) {
    req.logger.error(error);
    return await res
      .status(500)
      .json({ status: false, message: 'Error closing session', error });
  }
}

// WhatsApp Web's logout can hang (staging 2026-10-21: over 30 s, so the caller
// gave up and the session's browser stayed open). Past this, it is treated as a
// failed logout: the browser is closed and the removal finishes.
export const LOGOUT_TIMEOUT_MS = 10_000;

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function logOutSession(req: Request, res: Response): Promise<any> {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.operationId = 'logoutSession'
   * #swagger.description = 'This route logout and delete session data'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  try {
    const session = req.session;
    if (!/^[A-Za-z0-9_-]+$/.test(session)) {
      return res
        .status(400)
        .json({ status: false, message: 'Invalid session name' });
    }
    await cleanupSession(session, async (client) => {
      try {
        if (typeof client?.logout === 'function')
          await withTimeout(client.logout(), LOGOUT_TIMEOUT_MS, 'logout');
      } catch (error) {
        // The phone unlinked first: the page is reloading and logout() throws
        // ("InvocationInterface was not inited"). The device is unpaired either
        // way, so close the browser and finish the removal. A browser that
        // cannot be closed still owns its profile: keep the runtime for an
        // explicit cleanup instead (cleanupSession marks it ERROR).
        if (typeof client?.close !== 'function') throw error;
        req.logger.warn(
          `[${session}] logout failed, closing and removing it anyway: ${error}`
        );
        await withTimeout(client.close(), LOGOUT_TIMEOUT_MS, 'close');
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const pathUserData = path.resolve(config.customUserDataDir, session);
      const pathTokens = tokenFilePath(session);

      if (fs.existsSync(pathUserData)) {
        await fs.promises.rm(pathUserData, {
          recursive: true,
          maxRetries: 5,
          force: true,
          retryDelay: 1000,
        });
      }
      if (fs.existsSync(pathTokens)) {
        await fs.promises.rm(pathTokens, {
          recursive: true,
          maxRetries: 5,
          force: true,
          retryDelay: 1000,
        });
      }
    });
    req.io.emit('whatsapp-status', false);
    // callWebHook reads client.config; with no client it would throw after the
    // session is already gone.
    if (req.client)
      callWebHook(req.client, req, 'logoutsession', {
        message: `Session: ${session} logged out`,
        connected: false,
      });
    return res
      .status(200)
      .json({ status: true, message: 'Session successfully closed' });
  } catch (error) {
    req.logger.error(error);
    res
      .status(500)
      .json({ status: false, message: 'Error closing session', error });
  }
}

export async function checkConnectionSession(
  req: Request,
  res: Response
): Promise<any> {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.operationId = 'CheckConnectionState'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  try {
    await req.client.isConnected();

    res.status(200).json({ status: true, message: 'Connected' });
  } catch (error) {
    res.status(200).json({ status: false, message: 'Disconnected' });
  }
}

export async function downloadMediaByMessage(req: Request, res: Response) {
  /**
   * #swagger.tags = ["Messages"]
     #swagger.autoBody=false
     #swagger.operationId = 'downloadMediabyMessage'
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.requestBody = {
      required: true,
      "@content": {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              messageId: { type: "string" },
            }
          },
          example: {
            messageId: '<messageId>'
          }
        }
      }
     }
   */
  const client = req.client;
  const { messageId } = req.body;

  let message;

  try {
    if (!messageId.isMedia || !messageId.type) {
      message = await client.getMessageById(messageId);
    } else {
      message = messageId;
    }

    if (!message)
      return res.status(400).json({
        status: 'error',
        message: 'Message not found',
      });

    if (!(message['mimetype'] || message.isMedia || message.isMMS))
      return res.status(400).json({
        status: 'error',
        message: 'Message does not contain media',
      });

    const buffer = await client.decryptFile(message);

    res
      .status(200)
      .json({ base64: buffer.toString('base64'), mimetype: message.mimetype });
  } catch (e) {
    req.logger.error(e);
    res.status(400).json({
      status: 'error',
      message: 'Decrypt file error',
      error: e,
    });
  }
}

export async function getMediaByMessage(req: Request, res: Response) {
  /**
   * #swagger.tags = ["Messages"]
     #swagger.autoBody=false
     #swagger.operationId = 'getMediaByMessage'
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.parameters["session"] = {
      schema: 'messageId'
     }
   */
  const client = req.client;
  const { messageId } = req.params;

  try {
    const message = await client.getMessageById(messageId);

    if (!message)
      return res.status(400).json({
        status: 'error',
        message: 'Message not found',
      });

    if (!(message['mimetype'] || message.isMedia || message.isMMS))
      return res.status(400).json({
        status: 'error',
        message: 'Message does not contain media',
      });

    const buffer = await client.decryptFile(message);

    res
      .status(200)
      .json({ base64: buffer.toString('base64'), mimetype: message.mimetype });
  } catch (ex) {
    req.logger.error(ex);
    res.status(500).json({
      status: 'error',
      message: 'The session is not active',
      error: ex,
    });
  }
}

export async function getSessionState(req: Request, res: Response) {
  /**
     #swagger.tags = ["Auth"]
     #swagger.operationId = 'getSessionState'
     #swagger.summary = 'Retrieve status of a session'
     #swagger.autoBody = false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  try {
    const { waitQrCode = false } = req.body;
    const client = req.client;
    const qr =
      client?.urlcode != null && client?.urlcode != ''
        ? await QRCode.toDataURL(client.urlcode)
        : null;

    if ((client == null || client.status == null) && !waitQrCode)
      res.status(200).json({ status: 'CLOSED', qrcode: null });
    else if (client != null)
      res.status(200).json({
        status: client.status,
        qrcode: qr,
        urlcode: client.urlcode,
        version: version,
      });
  } catch (ex) {
    req.logger.error(ex);
    res.status(500).json({
      status: 'error',
      message: 'The session is not active',
      error: ex,
    });
  }
}

export async function getQrCode(req: Request, res: Response) {
  /**
   * #swagger.tags = ["Auth"]
     #swagger.autoBody=false
     #swagger.operationId = 'getQrCode'
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  try {
    if (req?.client?.urlcode) {
      // We add options to generate the QR code in higher resolution
      // The /qrcode-session request will now return a readable qrcode.
      const qrOptions = {
        errorCorrectionLevel: 'M' as const,
        type: 'image/png' as const,
        scale: 5,
        width: 500,
      };
      const qr = req.client.urlcode
        ? await QRCode.toDataURL(req.client.urlcode, qrOptions)
        : null;
      const img = Buffer.from(
        (qr as any).replace(/^data:image\/(png|jpeg|jpg);base64,/, ''),
        'base64'
      );
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': img.length,
      });
      res.end(img);
    } else if (typeof req.client === 'undefined') {
      res.status(200).json({
        status: null,
        message:
          'Session not started. Please, use the /start-session route, for initialization your session',
      });
    } else {
      res.status(200).json({
        status: req.client.status,
        message: 'QRCode is not available...',
      });
    }
  } catch (ex) {
    req.logger.error(ex);
    res
      .status(500)
      .json({ status: 'error', message: 'Error retrieving QRCode', error: ex });
  }
}

export async function killServiceWorker(req: Request, res: Response) {
  /**
   * #swagger.ignore=true
   * #swagger.tags = ["Messages"]
     #swagger.operationId = 'killServiceWorkier'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  try {
    res.status(200).json({ status: 'error', response: 'Not implemented yet' });
  } catch (ex) {
    req.logger.error(ex);
    res.status(500).json({
      status: 'error',
      message: 'The session is not active',
      error: ex,
    });
  }
}

export async function restartService(req: Request, res: Response) {
  /**
   * #swagger.ignore=true
   * #swagger.tags = ["Messages"]
     #swagger.operationId = 'restartService'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
   */
  try {
    res.status(200).json({ status: 'error', response: 'Not implemented yet' });
  } catch (ex) {
    req.logger.error(ex);
    res.status(500).json({
      status: 'error',
      response: { message: 'The session is not active', error: ex },
    });
  }
}

export async function subscribePresence(req: Request, res: Response) {
  /**
   * #swagger.tags = ["Misc"]
     #swagger.operationId = 'subscribePresence'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.requestBody = {
      required: true,
      "@content": {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              phone: { type: "string" },
              isGroup: { type: "boolean" },
              all: { type: "boolean" },
            }
          },
          example: {
            phone: '5521999999999',
            isGroup: false,
            all: false,
          }
        }
      }
     }
   */
  try {
    const { phone, isGroup = false, all = false } = req.body;

    if (all) {
      let contacts;
      if (isGroup) {
        const groups = await req.client.getAllGroups(false);
        contacts = groups.map((p: any) => p.id._serialized);
      } else {
        const chats = await req.client.getAllContacts();
        contacts = chats.map((c: any) => c.id._serialized);
      }
      await req.client.subscribePresence(contacts);
    } else
      for (const contato of contactToArray(phone, isGroup)) {
        await req.client.subscribePresence(contato);
      }

    res.status(200).json({
      status: 'success',
      response: { message: 'Subscribe presence executed' },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Error on subscribe presence',
      error: error,
    });
  }
}

export async function setOnlinePresence(req: Request, res: Response) {
  /**
   * #swagger.tags = ["Misc"]
     #swagger.operationId = 'setOnlinePresence'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.requestBody = {
      required: true,
      "@content": {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              isOnline: { type: "boolean" },
            }
          },
          example: {
   isOnline: false,
          }
        }
      }
     }
   */
  try {
    const { isOnline = true } = req.body;

    await req.client.setOnlinePresence(isOnline);

    res.status(200).json({
      status: 'success',
      response: { message: 'Set Online Presence Successfully' },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Error on set online presence',
      error: error,
    });
  }
}

export async function editBusinessProfile(req: Request, res: Response) {
  /**
   * #swagger.tags = ["Profile"]
     #swagger.operationId = 'editBusinessProfile'
   * #swagger.description = 'Edit your bussiness profile'
     #swagger.autoBody=false
     #swagger.security = [{
            "bearerAuth": []
     }]
     #swagger.parameters["session"] = {
      schema: 'NERDWHATS_AMERICA'
     }
     #swagger.parameters["obj"] = {
      in: 'body',
      schema: {
        $adress: 'Av. Nossa Senhora de Copacabana, 315',
        $email: 'test@test.com.br',
        $categories: {
          $id: "133436743388217",
          $localized_display_name: "Artes e entretenimento",
          $not_a_biz: false,
        },
        $website: [
          "https://www.wppconnect.io",
          "https://www.teste2.com.br",
        ],
      }
     }
     
     #swagger.requestBody = {
      required: true,
      "@content": {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              adress: { type: "string" },
              email: { type: "string" },
              categories: { type: "object" },
              websites: { type: "array" },
            }
          },
          example: {
            adress: 'Av. Nossa Senhora de Copacabana, 315',
            email: 'test@test.com.br',
            categories: {
              $id: "133436743388217",
              $localized_display_name: "Artes e entretenimento",
              $not_a_biz: false,
            },
            website: [
              "https://www.wppconnect.io",
              "https://www.teste2.com.br",
            ],
          }
        }
      }
     }
   */
  try {
    res.status(200).json(await req.client.editBusinessProfile(req.body));
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Error on edit business profile',
      error: error,
    });
  }
}
