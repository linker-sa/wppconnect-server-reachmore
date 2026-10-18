import fs from 'fs';
import path from 'path';

import { sessionDataDir, tokenFilePath, userDataDirBase } from './sessionPaths';

/**
 * Move dead sessions out of the boot queue.
 *
 * Every connect attempt mints a new session (`wpp_{tenant}_{timestamp}`), and
 * one that is never scanned still leaves a token and a profile behind. Boot
 * starts every token, so each abandoned attempt costs a browser sitting at a
 * QR screen until auto-close (60s), on every restart, forever. Staging had 12
 * of them; clearing them took a restart from 6.5 min to 17s.
 *
 * A session is parked when it reaches auto-close at the QR screen without ever
 * having logged in. Its token and profile are moved (not deleted) to
 * `inactive/`, after its browser has closed, so nothing is writing to the
 * profile. "Ever logged in" is a marker file per session on the same volume,
 * so a linked session that later shows a QR (the phone unlinked) is left
 * alone. PARK_UNLINKED_SESSIONS=false turns parking off.
 */
export const loggedInDir = path.join(sessionDataDir, 'logged-in');
export const inactiveDir = path.join(sessionDataDir, 'inactive');

const LOGGED_IN = new Set(['isLogged', 'inChat', 'qrReadSuccess']);
// Only the auto-close timer at the QR screen is definitive. qrReadError can be
// a failed check on a session that did pair.
const GAVE_UP = new Set(['autocloseCalled']);

type Logger = { info: (m: string) => unknown; warn: (m: string) => unknown };

export function parkingEnabled(): boolean {
  return (
    String(process.env.PARK_UNLINKED_SESSIONS ?? '')
      .trim()
      .toLowerCase() !== 'false'
  );
}

export function markLoggedIn(session: string, dir = loggedInDir): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, session), new Date().toISOString());
  } catch {
    // Unmarked only means the session could be parked if it later sits at a QR.
  }
}

export function hasLoggedIn(session: string, dir = loggedInDir): boolean {
  return fs.existsSync(path.join(dir, session));
}

function moveAside(from: string, toDir: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(toDir, { recursive: true });
  let to = path.join(toDir, path.basename(from));
  if (fs.existsSync(to)) to = `${to}.${Date.now()}`;
  fs.renameSync(from, to);
  return true;
}

/**
 * Move a session's token and profile to `inactive/`. Idempotent: whatever is
 * already gone is skipped.
 *
 * @param {string} session Session name.
 * @param {Logger} logger Where to log.
 * @param {object} paths Overridable for tests.
 * @return {boolean} true if anything was moved.
 */
export function parkSession(
  session: string,
  logger: Logger,
  {
    token = tokenFilePath(session),
    profile = userDataDirBase + session,
    inactive = inactiveDir,
  } = {}
): boolean {
  if (!parkingEnabled()) return false;
  try {
    const movedToken = moveAside(token, path.join(inactive, 'tokens'));
    const movedProfile = moveAside(profile, path.join(inactive, 'userDataDir'));
    if (movedToken || movedProfile)
      logger.info(
        `[${session}] parked: never logged in, token and profile moved to ${inactive}`
      );
    return movedToken || movedProfile;
  } catch (error) {
    logger.warn(`[${session}] could not be parked: ${error}`);
    return false;
  }
}

const giveUps = new Set<string>();

/**
 * Feed every statusFind here. Parks once the browser of a session that gave up
 * at the QR screen, without a login, has closed.
 *
 * @param {string} session Session name.
 * @param {string} status wppconnect statusFind value.
 * @param {Logger} logger Where to log.
 * @param {object} deps Overridable for tests.
 * @return {void}
 */
export function trackSessionStatus(
  session: string,
  status: string,
  logger: Logger,
  {
    loggedIn = (s: string) => hasLoggedIn(s),
    mark = (s: string) => markLoggedIn(s),
    park = (s: string) => parkSession(s, logger),
  } = {}
): void {
  if (LOGGED_IN.has(status)) {
    giveUps.delete(session);
    if (!loggedIn(session)) mark(session);
  } else if (GAVE_UP.has(status)) {
    if (!loggedIn(session)) giveUps.add(session);
  } else if (status === 'browserClose' && giveUps.delete(session)) {
    park(session);
  }
}
