import fs from 'fs';
import os from 'os';
import path from 'path';

import { clearStaleChromiumLocks } from '../sessionPaths';

/**
 * Chromium claims a profile by writing SingletonLock (a symlink naming the
 * owning host and pid), SingletonSocket and SingletonCookie, and removes them
 * on a clean shutdown. A replaced container never gets one, so they survive.
 *
 * That was harmless while the profile lived on the container filesystem and
 * died with it. Once the profile is on a mounted volume the lock outlives the
 * process that wrote it, and the next container cannot start the session:
 *
 *   Failed to launch the browser process: Code: 21
 *   The profile appears to be in use by another Chromium process (779) on
 *   another computer (1dd624ee2a4a).
 *
 * Observed on staging 2026-09-20: both sessions failed exactly this way on the
 * first redeploy after the volume was attached.
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('clearStaleChromiumLocks', () => {
  it('removes a SingletonLock symlink pointing at a host that no longer exists', () => {
    // The real shape: a DANGLING symlink to "<host>-<pid>". This is the case
    // that matters — the container it names is gone.
    fs.symlinkSync('1dd624ee2a4a-779', path.join(dir, 'SingletonLock'));

    expect(clearStaleChromiumLocks(dir)).toContain('SingletonLock');
    expect(fs.existsSync(path.join(dir, 'SingletonLock'))).toBe(false);
  });

  it('is not fooled by existsSync returning false for a dangling symlink', () => {
    // Guards the implementation choice: existsSync FOLLOWS the link, so it
    // reports false for exactly the lock we must delete. Using it would leave
    // the file in place and reproduce the bug.
    const link = path.join(dir, 'SingletonLock');
    fs.symlinkSync('does-not-resolve', link);

    expect(fs.existsSync(link)).toBe(false);
    expect(clearStaleChromiumLocks(dir)).toContain('SingletonLock');
  });

  it('removes the socket and cookie too', () => {
    fs.symlinkSync(
      '/tmp/.org.chromium.Chromium.abc',
      path.join(dir, 'SingletonSocket')
    );
    fs.writeFileSync(path.join(dir, 'SingletonCookie'), '1234');

    const removed = clearStaleChromiumLocks(dir);

    expect(removed).toEqual(
      expect.arrayContaining(['SingletonSocket', 'SingletonCookie'])
    );
  });

  it('leaves the rest of the profile untouched', () => {
    // The session's credentials live here. Deleting more than the locks would
    // turn a recoverable restart into a QR re-scan.
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(
      path.join(dir, 'Default', 'Local Storage'),
      'session-data'
    );
    fs.symlinkSync('host-1', path.join(dir, 'SingletonLock'));

    clearStaleChromiumLocks(dir);

    expect(
      fs.readFileSync(path.join(dir, 'Default', 'Local Storage'), 'utf8')
    ).toBe('session-data');
  });

  it('reports nothing removed for a clean profile', () => {
    expect(clearStaleChromiumLocks(dir)).toEqual([]);
  });

  it('does not throw for a profile directory that does not exist yet', () => {
    // First launch of a brand-new session.
    expect(() =>
      clearStaleChromiumLocks(path.join(dir, 'never-created'))
    ).not.toThrow();
  });
});
