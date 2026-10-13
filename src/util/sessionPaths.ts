import fs from 'fs';
import path from 'path';

/**
 * Where session state lives on disk.
 *
 * A WhatsApp session is two things: the token file (multi-device credentials
 * plus the session config, webhook URL included) and the Chromium profile.
 * With both present, a restart resumes the session without a QR scan; with
 * either missing, the merchant has to re-link.
 *
 * Both used to be fixed relative to the working directory, i.e. on the
 * container's own filesystem. On a platform that replaces the container on
 * every deploy (Railway), that meant every deploy logged every tenant out.
 *
 * SESSION_DATA_DIR moves both under one directory so a single mounted volume
 * covers them — Railway allows one volume per service. Unset, everything stays
 * exactly where it was (`./tokens`, `./userDataDir/`).
 */
const base = (process.env.SESSION_DATA_DIR || '').trim();

/** Directory holding `<session>.data.json` token files. */
export const tokensDir = base ? path.join(base, 'tokens') : './tokens';

/** Prefix the session name is appended to for its Chromium profile. */
export const userDataDirBase = base
  ? path.join(base, 'userDataDir') + path.sep
  : './userDataDir/';

/**
 * Absolute path of one session's token file.
 *
 * @param {string} session Session name.
 * @return {string} Absolute token file path.
 */
export function tokenFilePath(session: string): string {
  return path.resolve(process.cwd(), tokensDir, `${session}.data.json`);
}

/**
 * Lock files Chromium writes into a profile to claim exclusive ownership.
 *
 * `SingletonLock` is a symlink naming the owning host and pid; the other two
 * are its socket and cookie. Chromium removes them on a clean shutdown.
 */
const CHROMIUM_LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
];

/**
 * Remove stale Chromium singleton locks from a session's profile.
 *
 * A container that is replaced — every deploy, and any restart — never gets to
 * shut Chromium down cleanly, so these files survive. That was harmless while
 * the profile lived on the container's own filesystem and died with it. Once
 * the profile is on a mounted volume the lock outlives the process that made
 * it, and the next container refuses to launch:
 *
 *   Failed to launch the browser process: Code: 21
 *   The profile appears to be in use by another Chromium process (779) on
 *   another computer (1dd624ee2a4a). Chromium has locked the profile...
 *
 * The owning process is always gone by then: it lived in a container that no
 * longer exists. Within a container a profile is only ever launched once — a
 * session that is already running short-circuits before this — so a lock found
 * here cannot belong to a live browser.
 *
 * Best effort by design: failing to clear a lock must not stop the launch
 * attempt, which will simply fail the way it does today.
 *
 * @param {string} profileDir The session's `userDataDir`.
 * @return {string[]} Names of the lock files actually removed.
 */
export function clearStaleChromiumLocks(profileDir: string): string[] {
  const removed: string[] = [];
  for (const name of CHROMIUM_LOCK_FILES) {
    const target = path.join(profileDir, name);
    try {
      // `lstat`, not `existsSync`: SingletonLock is a symlink to a host/pid
      // that does not resolve, so `existsSync` reports false and the file is
      // left behind — which is the whole bug.
      fs.lstatSync(target);
      fs.unlinkSync(target);
      removed.push(name);
    } catch {
      // Absent, or unremovable — neither is worth failing a launch over.
    }
  }
  return removed;
}
