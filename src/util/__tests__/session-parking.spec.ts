import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  hasLoggedIn,
  markLoggedIn,
  parkSession,
  trackSessionStatus,
} from '../sessionParking';

/**
 * Every abandoned connect attempt left a token and a profile that boot started
 * again on every restart, each one sitting at a QR screen for 60s. These pin
 * which sessions are parked, and that parking moves rather than deletes.
 */
const logger = () => ({ info: jest.fn(), warn: jest.fn() });

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'parking-'));
  delete process.env.PARK_UNLINKED_SESSIONS;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seedSession(session: string) {
  const token = path.join(root, 'tokens', `${session}.data.json`);
  const profile = path.join(root, 'userDataDir', session);
  fs.mkdirSync(path.dirname(token), { recursive: true });
  fs.writeFileSync(token, '{}');
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), '{}');
  return { token, profile, inactive: path.join(root, 'inactive') };
}

describe('parkSession', () => {
  it('moves the token and the profile to inactive/', () => {
    const paths = seedSession('wpp_t_1');
    expect(parkSession('wpp_t_1', logger(), paths)).toBe(true);
    expect(fs.existsSync(paths.token)).toBe(false);
    expect(fs.existsSync(paths.profile)).toBe(false);
    expect(
      fs.existsSync(path.join(root, 'inactive', 'tokens', 'wpp_t_1.data.json'))
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(root, 'inactive', 'userDataDir', 'wpp_t_1', 'Default')
      )
    ).toBe(true);
  });

  it('is idempotent, and keeps an earlier parked copy', () => {
    const paths = seedSession('wpp_t_1');
    parkSession('wpp_t_1', logger(), paths);
    expect(parkSession('wpp_t_1', logger(), paths)).toBe(false);

    seedSession('wpp_t_1');
    expect(parkSession('wpp_t_1', logger(), paths)).toBe(true);
    expect(
      fs.readdirSync(path.join(root, 'inactive', 'userDataDir'))
    ).toHaveLength(2);
  });

  it('does nothing when PARK_UNLINKED_SESSIONS=false', () => {
    process.env.PARK_UNLINKED_SESSIONS = 'false';
    const paths = seedSession('wpp_t_1');
    expect(parkSession('wpp_t_1', logger(), paths)).toBe(false);
    expect(fs.existsSync(paths.token)).toBe(true);
  });
});

describe('logged-in marker', () => {
  it('remembers a session that logged in', () => {
    const dir = path.join(root, 'logins');
    expect(hasLoggedIn('wpp_t_1', dir)).toBe(false);
    markLoggedIn('wpp_t_1', dir);
    expect(hasLoggedIn('wpp_t_1', dir)).toBe(true);
  });
});

describe('trackSessionStatus', () => {
  function tracker(loggedInBefore: string[] = []) {
    const marked = new Set(loggedInBefore);
    const parked: string[] = [];
    const deps = {
      loggedIn: (s: string) => marked.has(s),
      mark: (s: string) => marked.add(s),
      park: (s: string) => parked.push(s) > 0,
    };
    const feed = (session: string, ...statuses: string[]) =>
      statuses.forEach((s) => trackSessionStatus(session, s, logger(), deps));
    return { feed, parked, marked };
  }

  it('parks an abandoned connect attempt once its browser has closed', () => {
    const t = tracker();
    t.feed('wpp_a', 'notLogged', 'autocloseCalled', 'qrReadError');
    expect(t.parked).toEqual([]); // browser still closing
    t.feed('wpp_a', 'browserClose');
    expect(t.parked).toEqual(['wpp_a']);
  });

  it('never parks a session that has logged in before', () => {
    const t = tracker(['wpp_a']);
    t.feed('wpp_a', 'notLogged', 'autocloseCalled', 'browserClose');
    expect(t.parked).toEqual([]);
  });

  it('marks a login, so a later QR timeout does not park it', () => {
    const t = tracker();
    t.feed('wpp_a', 'isLogged');
    expect(t.marked.has('wpp_a')).toBe(true);
    t.feed('wpp_a', 'autocloseCalled', 'browserClose');
    expect(t.parked).toEqual([]);
  });

  it('still parks an unpaired session that flashed inChat while loading', () => {
    const t = tracker();
    t.feed('wpp_a', 'inChat', 'notLogged', 'autocloseCalled', 'browserClose');
    expect(t.marked.has('wpp_a')).toBe(false);
    expect(t.parked).toEqual(['wpp_a']);
  });

  it('does not park on a slow sync after a scan', () => {
    const t = tracker();
    t.feed('wpp_a', 'notLogged', 'qrReadSuccess', 'autocloseCalled');
    t.feed('wpp_a', 'browserClose');
    expect(t.parked).toEqual([]);
  });

  it('does not park on an ordinary browser close', () => {
    const t = tracker();
    t.feed('wpp_b', 'browserClose');
    t.feed('wpp_c', 'qrReadError', 'browserClose');
    expect(t.parked).toEqual([]);
  });
});
