import dotenv from 'dotenv';

import { ServerOptions } from './types/ServerOptions';
import { userDataDirBase } from './util/sessionPaths';

// Loading is optional; deployment environment variables keep precedence.
dotenv.config({ override: false });
const env = process.env;

function envNumber(name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default {
  secretKey: env.SECRET_KEY || 'THISISMYSECURETOKEN',
  host: env.HOST || 'http://localhost',
  port: env.PORT || '21465',
  deviceName: 'WppConnect',
  poweredBy: 'WPPConnect-Server',
  startAllSession: true,
  tokenStoreType: env.TOKEN_STORE_TYPE || 'file',
  maxListeners: envNumber('MAX_LISTENERS', 15),
  // From SESSION_DATA_DIR (sessionPaths), not CUSTOM_USER_DATA_DIR: parking and
  // restore read the same base, so the two must never point at different disks.
  customUserDataDir: userDataDirBase,
  webhook: {
    url: env.WEBHOOK_URL || null,
    allowedUrls: (env.WEBHOOK_ALLOWED_URLS || '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    autoDownload: true,
    retryAttempts: envNumber('WEBHOOK_RETRY_ATTEMPTS', 3),
    retryDelay: envNumber('WEBHOOK_RETRY_DELAY', 5000),
    requestTimeout: envNumber('WEBHOOK_REQUEST_TIMEOUT', 30000),
    // Bytes; media larger than this is not inlined as base64 (0 = no limit).
    autoDownloadMaxSize: envNumber('WEBHOOK_AUTO_DOWNLOAD_MAX_SIZE', 0),
    uploadS3: false,
    readMessage: true,
    allUnreadOnStart: false,
    listenAcks: true,
    onPresenceChanged: true,
    onParticipantsChanged: true,
    onReactionMessage: true,
    onPollResponse: true,
    onRevokedMessage: true,
    onLabelUpdated: true,
    // Phone replies only — the receiver reads them as a human takeover.
    onSelfMessage: true,
    ignore: ['status@broadcast'],
  },
  websocket: {
    autoDownload: false,
    uploadS3: false,
  },
  chatwoot: {
    sendQrCode: true,
    sendStatus: true,
  },
  archive: {
    enable: false,
    waitTime: 10,
    daysToArchive: 45,
  },
  log: {
    level: 'silly', // Before open a issue, change level to silly and retry a action
    logger: ['console', 'file'],
  },
  createOptions: {
    /**
     * How long a freshly authenticated session may stay in SYNCING before
     * wppconnect closes the page (host.layer `startAutoClose`). The library
     * default of 180s is too short for an account with a large history: the
     * page gets closed mid-sync, every later call fails with "WAPI is not
     * defined", the tenant reconnects, and the next cold sync hits the same
     * wall — a self-sustaining disconnect loop.
     *
     * Observed on staging 2026-08-17: CONNECTED at 14:20:41, still SYNCING,
     * page closed at ~14:23:51 — 190s, i.e. exactly this timeout.
     *
     * Not disabled entirely (0), so a genuinely stuck sync is still cleaned up
     * rather than holding a dead browser open forever. The real cure is
     * persisting `tokens/` and `userDataDir/` so syncs are warm instead of
     * cold; this only stops a slow first sync from being fatal.
     */
    deviceSyncTimeout: 600000,
    browserArgs: [
      '--disable-web-security',
      '--no-sandbox',
      // NOTE: the browser cache is deliberately NOT disabled here. Flags like
      // --disable-cache / --disk-cache-size=0 / --aggressive-cache-discard save
      // a little disk but force WhatsApp Web to re-download its whole bundle
      // and re-sync from scratch on every load, which is what pushed the
      // initial sync past deviceSyncTimeout above. Caching is what makes a
      // restart cheap.
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list',
    ],
    /**
     * Example of configuring the linkPreview generator
     * If you set this to 'null', it will use global servers; however, you have the option to define your own server
     * Clone the repository https://github.com/wppconnect-team/wa-js-api-server and host it on your server with ssl
     *
     * Configure the attribute as follows:
     * linkPreviewApiServers: [ 'https://www.yourserver.com/wa-js-api-server' ]
     */
    linkPreviewApiServers: null,

    /**
     * Set specific whatsapp version
     */
    // whatsappVersion: '2.xxxxx',
  },
  mapper: {
    enable: false,
    prefix: 'tagone-',
  },
  db: {
    mongodbDatabase: env.MONGODB_DATABASE || 'tokens',
    mongodbCollection: env.MONGODB_COLLECTION || '',
    mongodbUser: env.MONGODB_USER || '',
    mongodbPassword: env.MONGODB_PASSWORD || '',
    mongodbHost: env.MONGODB_HOST || '',
    mongoIsRemote: true,
    mongoURLRemote: env.MONGO_URL_REMOTE || '',
    mongodbPort: envNumber('MONGODB_PORT', 27017),
    redisHost: env.REDIS_HOST || 'localhost',
    redisPort: envNumber('REDIS_PORT', 6379),
    redisPassword: env.REDIS_PASSWORD || '',
    redisDb: envNumber('REDIS_DB', 0),
    redisPrefix: env.REDIS_PREFIX || 'docker',
  },
  aws_s3: {
    region: 'sa-east-1' as any,
    access_key_id: null,
    secret_key: null,
    defaultBucketName: null,
    endpoint: null,
    forcePathStyle: null,
  },
} as unknown as ServerOptions;
