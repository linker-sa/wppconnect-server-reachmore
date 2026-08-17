import { ServerOptions } from './types/ServerOptions';

export default {
  secretKey: process.env.SECRET_KEY || 'THISISMYSECURETOKEN',
  host: 'http://localhost',
  port: process.env.PORT || '21465',
  deviceName: 'WppConnect',
  poweredBy: 'WPPConnect-Server',
  startAllSession: true,
  tokenStoreType: 'file',
  maxListeners: 15,
  customUserDataDir: './userDataDir/',
  webhook: {
    url: null,
    autoDownload: true,
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
    onSelfMessage: false,
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
    mongodbDatabase: 'tokens',
    mongodbCollection: '',
    mongodbUser: '',
    mongodbPassword: '',
    mongodbHost: '',
    mongoIsRemote: true,
    mongoURLRemote: '',
    mongodbPort: 27017,
    redisHost: 'localhost',
    redisPort: 6379,
    redisPassword: '',
    redisDb: 0,
    redisPrefix: 'docker',
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
