import { scanProcesses } from './resourceMonitor';
import { userDataDirBase } from './sessionPaths';

/**
 * Close every session's browser cleanly when the platform stops the server.
 *
 * Railway stops the old deployment with SIGTERM, waits the service's draining
 * time, then sends SIGKILL; with a volume attached the old deployment is
 * always stopped before the new one starts. Left to puppeteer, SIGTERM
 * *kills* each Chromium's process group (@puppeteer/browsers `launch.js`,
 * `#onDriverProcessSignal`) instead of closing it, and because a listener is
 * installed Node itself no longer exits: it idles until the SIGKILL.
 * Reproduced locally on 2026-09-22: 10s after SIGTERM Node was still alive
 * and every profile still held its Singleton* locks, the mark of a Chromium
 * that did not shut down.
 *
 * Two costs. With a volume the next deployment cannot start until this one
 * is gone, so the idle wait for SIGKILL is pure downtime on every deploy. And
 * a kill skips Chromium's shutdown, so whatever it had not flushed to the
 * profile (WhatsApp keeps the linked session in IndexedDB there) is lost or
 * left mid-write. Staging has survived kills so far; a clean close removes the
 * risk instead of relying on that. So puppeteer's own signal handling is
 * switched off (see createSessionUtil), each connected client is closed
 * through wppconnect's `close()`, which asks Chromium to shut down, and the
 * process exits.
 *
 * Sessions that are still starting have no client object yet, so they cannot
 * be closed this way. Their browsers are killed explicitly before exiting:
 * puppeteer's own exit hook is meant to, but its shared dispatcher iterates
 * the listener array while each kill() splices itself out of it, so every
 * other browser is skipped. Reproduced: of two starting browsers, one
 * survived the server as an orphan.
 *
 * SHUTDOWN_TIMEOUT_MS bounds the whole thing (default 20s). Keep it below the
 * service's draining time (RAILWAY_DEPLOYMENT_DRAINING_SECONDS), or the
 * SIGKILL arrives first.
 */
export const SHUTDOWN_TIMEOUT_MS = (() => {
  const value = Number.parseInt(
    String(process.env.SHUTDOWN_TIMEOUT_MS ?? '').trim(),
    10
  );
  return Number.isFinite(value) && value > 0 ? value : 20000;
})();

type Logger = {
  info: (message: string) => unknown;
  warn: (message: string) => unknown;
};

/**
 * Close every connected client, bounded by `timeoutMs`.
 *
 * @param {Record<string, any>} clients The server's `clientsArray`.
 * @param {Logger} logger Where to log.
 * @param {number} timeoutMs Upper bound for the whole close.
 * @return {Promise<{closed: string[], timedOut: boolean}>} What happened.
 */
export async function closeAllSessions(
  clients: Record<string, any>,
  logger: Logger,
  timeoutMs = SHUTDOWN_TIMEOUT_MS
): Promise<{ closed: string[]; timedOut: boolean }> {
  const closable = Object.entries(clients).filter(
    ([, client]) => client?.page && typeof client.close === 'function'
  );
  const closed: string[] = [];

  const closing = Promise.all(
    closable.map(async ([session, client]) => {
      try {
        await client.close();
        closed.push(session);
      } catch (error) {
        logger.warn(`[${session}] did not close cleanly: ${error}`);
      }
    })
  );

  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    closing.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return { closed, timedOut };
}

/**
 * Kill every Chromium browser still running from a session profile. Only
 * profiles under the server's own session directory are touched.
 *
 * @param {Logger} logger Where to log.
 * @param {object} options procfs root and kill function; overridable for tests.
 * @return {string[]} Sessions whose browser had to be killed.
 */
export function killRemainingBrowsers(
  logger: Logger,
  {
    procRoot = '/proc',
    profileBase = userDataDirBase,
    kill = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
  }: {
    procRoot?: string;
    profileBase?: string;
    kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  } = {}
): string[] {
  const killed: string[] = [];
  const { browsers } = scanProcesses(procRoot, profileBase);
  for (const [session, pid] of browsers) {
    try {
      // puppeteer launches each browser detached, as its own process group,
      // so the negative pid takes the renderers and GPU process with it.
      kill(-pid, 'SIGKILL');
    } catch {
      try {
        kill(pid, 'SIGKILL');
      } catch {
        continue; // already gone
      }
    }
    killed.push(session);
  }
  if (killed.length)
    logger.warn(
      `Killed ${
        killed.length
      } browser(s) that could not be closed: ${killed.join(', ')}`
    );
  return killed;
}

interface ShutdownOptions {
  timeoutMs?: number;
  exit?: (code: number) => void;
  signals?: NodeJS.Signals[];
  killLeftovers?: (logger: Logger) => unknown;
}

/**
 * Handle SIGTERM/SIGINT by closing sessions, then exiting.
 *
 * @param {Record<string, any>} clients The server's `clientsArray`.
 * @param {Logger} logger Where to log.
 * @param {object} options Overridable for tests.
 * @return {(signal: string) => Promise<void>} The installed handler.
 */
export function installGracefulShutdown(
  clients: Record<string, any>,
  logger: Logger,
  {
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    exit = (code) => process.exit(code),
    signals = ['SIGTERM', 'SIGINT'],
    killLeftovers = killRemainingBrowsers,
  }: ShutdownOptions = {}
): (signal: string) => Promise<void> {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    // A second signal (e.g. an impatient Ctrl-C) must not start a second
    // round of closes on browsers that are already closing.
    if (shuttingDown) return;
    shuttingDown = true;

    const started = Date.now();
    logger.info(`${signal} received: closing sessions before exit`);
    const { closed, timedOut } = await closeAllSessions(
      clients,
      logger,
      timeoutMs
    );
    logger.info(
      `Closed ${closed.length} session(s) in ${Date.now() - started}ms` +
        (timedOut ? ` (stopped waiting after ${timeoutMs}ms)` : '') +
        (closed.length ? `: ${closed.join(', ')}` : '')
    );
    try {
      killLeftovers(logger);
    } finally {
      exit(0);
    }
  };

  for (const signal of signals) process.on(signal, handler);
  return handler;
}
