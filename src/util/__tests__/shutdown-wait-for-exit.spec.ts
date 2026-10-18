import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  closeAndWaitForExit,
  killRemainingBrowsers,
  waitForExit,
  waitForGroupExit,
} from '../gracefulShutdown';
import { liveGroupMembers } from '../resourceMonitor';

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
    expect(log.info.mock.calls[0][0]).toMatch(
      /\[s\] browser group exited in \d+ms/
    );
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
      {
        clients: { wpp_a: c },
        procRoot: '/nonexistent',
        kill,
        running: () => true,
      }
    );
    expect(killed).toEqual(['wpp_a']);
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
  });

  it('leaves a group with nothing running alone, and does not report it', () => {
    const kill = jest.fn();
    const log = { info: jest.fn(), warn: jest.fn() };
    const c = { page: { browser: () => ({ process: () => ({ pid: 4321 }) }) } };
    const killed = killRemainingBrowsers(log, {
      clients: { wpp_a: c },
      procRoot: '/nonexistent',
      kill,
      running: () => false,
    });
    expect(killed).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

/**
 * Staging, after #9: "browser exited in 205ms", then "Killed 1 browser(s)" and
 * stale locks on the next boot. The launched process exiting is not the whole
 * browser; shutdown now waits for its process group, and zombies (Node is PID
 * 1 and never reaps them) do not count as running.
 */
describe('liveGroupMembers', () => {
  function fakeProc(procs: Array<[number, string, number]>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
    for (const [pid, state, pgrp] of procs) {
      fs.mkdirSync(path.join(root, String(pid)));
      fs.writeFileSync(
        path.join(root, String(pid), 'stat'),
        `${pid} (chromium (renderer)) ${state} 1 ${pgrp} ${pgrp} 0 -1`
      );
    }
    fs.mkdirSync(path.join(root, 'self'));
    return root;
  }

  it('lists running members of the group, not zombies or other groups', () => {
    const root = fakeProc([
      [100, 'S', 100],
      [101, 'Z', 100],
      [102, 'R', 100],
      [200, 'S', 200],
    ]);
    expect(liveGroupMembers(100, root)?.sort()).toEqual([100, 102]);
  });

  it('reports a group of zombies as empty', () => {
    const root = fakeProc([
      [100, 'Z', 100],
      [101, 'Z', 100],
    ]);
    expect(liveGroupMembers(100, root)).toEqual([]);
  });

  it('returns null where procfs cannot be read', () => {
    expect(liveGroupMembers(100, '/nonexistent')).toBeNull();
  });
});

describe('waitForGroupExit', () => {
  it('waits until the group is gone', async () => {
    let polls = 0;
    await expect(waitForGroupExit(100, 5000, () => ++polls < 3)).resolves.toBe(
      true
    );
    expect(polls).toBe(3);
  });

  it('gives up at the deadline', async () => {
    await expect(waitForGroupExit(100, 150, () => true)).resolves.toBe(false);
  });

  it('treats a missing pid as gone', async () => {
    await expect(waitForGroupExit(null, 10, () => true)).resolves.toBe(true);
  });
});

describe('closeAndWaitForExit with a lingering group', () => {
  it('waits for the group after the browser process exits', async () => {
    const proc = Object.assign(new FakeProc(), { pid: 100 });
    const c = client(proc);
    const log = logger();
    let polls = 0;
    await expect(
      closeAndWaitForExit('s', c, log, Date.now() + 5000, () => ++polls < 3)
    ).resolves.toBe(true);
    expect(log.info.mock.calls[0][0]).toMatch(/group exited/);
  });

  it('reports a group that outlives the deadline', async () => {
    const proc = Object.assign(new FakeProc(), { pid: 100 });
    const log = logger();
    await expect(
      closeAndWaitForExit('s', client(proc), log, Date.now() + 300, () => true)
    ).resolves.toBe(false);
    expect(log.warn.mock.calls[0][0]).toMatch(/group is still running/);
  });
});
