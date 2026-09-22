import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  closeAllSessions,
  installGracefulShutdown,
  killRemainingBrowsers,
} from '../gracefulShutdown';

/**
 * On SIGTERM puppeteer used to kill every Chromium and leave Node idling
 * until SIGKILL. These pin the replacement: connected sessions are closed
 * through wppconnect, bounded in time, then the process exits.
 */
const logger = () => ({ info: jest.fn(), warn: jest.fn() });

const connected = (
  close: () => Promise<unknown> = () => Promise.resolve()
) => ({
  page: {},
  close: jest.fn(close),
});

afterEach(() => jest.useRealTimers());

describe('closeAllSessions', () => {
  it('closes every connected client and skips placeholders', async () => {
    const a = connected();
    const b = connected();
    const clients: Record<string, any> = {
      wpp_a: a,
      wpp_b: b,
      // Still starting: the server only stores the real client after login.
      wpp_starting: { status: 'INITIALIZING', session: 'wpp_starting' },
      wpp_gone: undefined,
    };

    const result = await closeAllSessions(clients, logger(), 1000);

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ closed: ['wpp_a', 'wpp_b'], timedOut: false });
  });

  it('closes the rest when one close fails', async () => {
    const log = logger();
    const result = await closeAllSessions(
      {
        bad: connected(() => Promise.reject(new Error('Target closed'))),
        good: connected(),
      },
      log,
      1000
    );
    expect(result.closed).toEqual(['good']);
    expect(log.warn).toHaveBeenCalledWith(
      '[bad] did not close cleanly: Error: Target closed'
    );
  });

  it('stops waiting at the timeout so the SIGKILL never comes first', async () => {
    jest.useFakeTimers();
    const pending = closeAllSessions(
      { stuck: connected(() => new Promise(() => undefined)) },
      logger(),
      20000
    );
    await jest.advanceTimersByTimeAsync(20000);
    await expect(pending).resolves.toEqual({ closed: [], timedOut: true });
  });
});

describe('installGracefulShutdown', () => {
  const installed: Array<(signal: string) => Promise<void>> = [];
  afterEach(() => {
    for (const handler of installed.splice(0)) {
      process.removeListener('SIGTERM', handler);
      process.removeListener('SIGUSR2', handler);
    }
  });

  it('closes sessions, then exits 0', async () => {
    const order: string[] = [];
    const client = connected(async () => {
      order.push('close');
    });
    const exit = jest.fn(() => {
      order.push('exit');
    });

    const handler = installGracefulShutdown({ wpp_a: client }, logger(), {
      timeoutMs: 1000,
      exit,
      signals: ['SIGUSR2'],
      killLeftovers: () => order.push('kill leftovers'),
    });
    installed.push(handler);
    await handler('SIGTERM');

    expect(order).toEqual(['close', 'kill leftovers', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second signal while the first shutdown is running', async () => {
    let release: () => void = () => undefined;
    const client = connected(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const exit = jest.fn();
    const handler = installGracefulShutdown({ wpp_a: client }, logger(), {
      timeoutMs: 1000,
      exit,
      signals: ['SIGUSR2'],
      killLeftovers: () => undefined,
    });
    installed.push(handler);

    const first = handler('SIGTERM');
    await handler('SIGINT');
    release();
    await first;

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('is what the process runs on the signal', () => {
    const before = process.listenerCount('SIGUSR2');
    const handler = installGracefulShutdown({}, logger(), {
      exit: jest.fn(),
      signals: ['SIGUSR2'],
      killLeftovers: () => undefined,
    });
    installed.push(handler);
    expect(process.listeners('SIGUSR2')).toContain(handler);
    expect(process.listenerCount('SIGUSR2')).toBe(before + 1);
  });
});

describe('killRemainingBrowsers', () => {
  const profileBase = '/data/userDataDir/';
  let proc: string;
  beforeEach(() => {
    proc = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-proc-'));
  });
  afterEach(() => fs.rmSync(proc, { recursive: true, force: true }));

  const fakeProcess = (pid: number, ppid: number, cmdline: string) => {
    const dir = path.join(proc, String(pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (chromium) S ${ppid} 0`);
    fs.writeFileSync(path.join(dir, 'cmdline'), cmdline);
  };

  it('kills each leftover browser as a process group', () => {
    fakeProcess(100, 1, 'chromium --user-data-dir=/data/userDataDir/wpp_a');
    fakeProcess(101, 100, 'chromium --type=renderer');
    fakeProcess(200, 1, 'chromium --user-data-dir=/data/userDataDir/wpp_b');
    const kill = jest.fn();
    const log = logger();

    const killed = killRemainingBrowsers(log, {
      procRoot: proc,
      profileBase,
      kill,
    });

    expect(killed.sort()).toEqual(['wpp_a', 'wpp_b']);
    expect(kill.mock.calls.sort()).toEqual([
      [-100, 'SIGKILL'],
      [-200, 'SIGKILL'],
    ]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('falls back to the pid, and skips a browser that is already gone', () => {
    fakeProcess(100, 1, 'chromium --user-data-dir=/data/userDataDir/wpp_a');
    fakeProcess(200, 1, 'chromium --user-data-dir=/data/userDataDir/wpp_b');
    const kill = jest.fn((pid: number) => {
      if (pid < 0) throw new Error('ESRCH'); // not a group leader
      if (pid === 200) throw new Error('ESRCH'); // exited meanwhile
    });

    const killed = killRemainingBrowsers(logger(), {
      procRoot: proc,
      profileBase,
      kill,
    });

    expect(killed).toEqual(['wpp_a']);
    expect(kill).toHaveBeenCalledWith(100, 'SIGKILL');
  });

  it("never touches a browser outside the server's session directory", () => {
    fakeProcess(
      100,
      1,
      'chrome --user-data-dir=/home/dev/.config/google-chrome'
    );
    fakeProcess(
      200,
      1,
      'chromium --user-data-dir=/tmp/puppeteer_dev_profile-x'
    );
    fakeProcess(
      300,
      1,
      'chromium --user-data-dir=/data/userDataDir/wpp_a/nested'
    );
    fakeProcess(400, 1, 'chromium --user-data-dir=/data/userDataDir/wpp_ours');
    const kill = jest.fn();

    const killed = killRemainingBrowsers(logger(), {
      procRoot: proc,
      profileBase,
      kill,
    });

    expect(killed).toEqual(['wpp_ours']);
    expect(kill.mock.calls).toEqual([[-400, 'SIGKILL']]);
  });

  it('does nothing and logs nothing when every browser was closed', () => {
    const log = logger();
    expect(
      killRemainingBrowsers(log, {
        procRoot: proc,
        profileBase,
        kill: jest.fn(),
      })
    ).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
