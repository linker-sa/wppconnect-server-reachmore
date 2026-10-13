import { EventEmitter } from 'events';

import {
  closeAndWaitForExit,
  killRemainingBrowsers,
  waitForExit,
} from '../gracefulShutdown';

/**
 * wppconnect's close() can return while Chromium is still running (it swallows
 * browser.close() errors). On staging that left the profile's lock files behind
 * on every restart. These pin that shutdown now waits for the process itself.
 */
class FakeProc extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  exit() {
    this.exitCode = 0;
    this.emit('exit');
  }
}

const logger = () => ({ info: jest.fn(), warn: jest.fn() });

function client(
  proc: FakeProc,
  { exitOnClose = true, exitOnSecondClose = true } = {}
) {
  let browserCloses = 0;
  const browser = {
    process: () => proc,
    close: jest.fn(async () => {
      browserCloses += 1;
      if (exitOnSecondClose) proc.exit();
    }),
  };
  return {
    browser,
    browserCloses: () => browserCloses,
    page: { browser: () => browser },
    close: jest.fn(async () => {
      if (exitOnClose) setImmediate(() => proc.exit());
    }),
  };
}

afterEach(() => jest.useRealTimers());

describe('waitForExit', () => {
  it('resolves true at once for an exited or missing process', async () => {
    const p = new FakeProc();
    p.exitCode = 0;
    await expect(waitForExit(p, 10)).resolves.toBe(true);
    await expect(waitForExit(null, 10)).resolves.toBe(true);
  });

  it('resolves false if the process outlives the wait', async () => {
    await expect(waitForExit(new FakeProc(), 20)).resolves.toBe(false);
  });
});

describe('closeAndWaitForExit', () => {
  it('waits for the browser process, not just close()', async () => {
    const proc = new FakeProc();
    const c = client(proc);
    const log = logger();
    await expect(
      closeAndWaitForExit('s', c, log, Date.now() + 5000)
    ).resolves.toBe(true);
    expect(proc.exitCode).toBe(0);
    expect(c.browser.close).not.toHaveBeenCalled();
    expect(log.info.mock.calls[0][0]).toMatch(/\[s\] browser exited in \d+ms/);
  });

  it('asks the browser to close again when close() left it running', async () => {
    jest.useFakeTimers();
    const proc = new FakeProc();
    const c = client(proc, { exitOnClose: false });
    const done = closeAndWaitForExit('s', c, logger(), Date.now() + 20000);
    await jest.advanceTimersByTimeAsync(2000);
    jest.useRealTimers();
    await expect(done).resolves.toBe(true);
    expect(c.browserCloses()).toBe(1);
  });

  it('reports a browser that never exits, without hanging past the deadline', async () => {
    jest.useFakeTimers();
    const proc = new FakeProc();
    const c = client(proc, { exitOnClose: false, exitOnSecondClose: false });
    const log = logger();
    const done = closeAndWaitForExit('s', c, log, Date.now() + 5000);
    await jest.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(false);
    expect(log.warn.mock.calls[0][0]).toMatch(/still running/);
  });
});

describe('killRemainingBrowsers', () => {
  it('kills a still-running client browser by its PID', () => {
    const kill = jest.fn();
    const c = { page: { browser: () => ({ process: () => ({ pid: 4321 }) }) } };
    const killed = killRemainingBrowsers(
      { info: jest.fn(), warn: jest.fn() },
      { clients: { wpp_a: c }, procRoot: '/nonexistent', kill }
    );
    expect(killed).toEqual(['wpp_a']);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });
});
