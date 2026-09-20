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
