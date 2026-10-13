import { startWithLimit } from '../sessionStartQueue';

/**
 * On boot the server starts every stored session. It used to launch them all
 * in the same tick, so the memory/CPU peak grew with the tenant count
 * (measured: 4 at once = 2.27 GB and 3.5 cores). These pin the queue that
 * replaced it: bounded, never stalled by one slow or failing session.
 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function controllable() {
  const pending = new Map<string, () => void>();
  const failures = new Map<string, (e: Error) => void>();
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const start = (item: string) =>
    new Promise<void>((resolve, reject) => {
      started.push(item);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      pending.set(item, () => {
        inFlight--;
        resolve();
      });
      failures.set(item, (e) => {
        inFlight--;
        reject(e);
      });
    });
  return {
    start,
    started,
    finish: (item: string) => pending.get(item)!(),
    fail: (item: string, e: Error) => failures.get(item)!(e),
    maxInFlight: () => maxInFlight,
  };
}

describe('startWithLimit', () => {
  it('never runs more starts at once than the limit', async () => {
    const c = controllable();
    const items = ['a', 'b', 'c', 'd', 'e'];
    const done = startWithLimit(items, c.start, {
      concurrency: 2,
      slotTimeoutMs: 0,
    });

    await tick();
    expect(c.started).toEqual(['a', 'b']);

    c.finish('a');
    await tick();
    expect(c.started).toEqual(['a', 'b', 'c']);

    for (const item of ['b', 'c', 'd', 'e']) {
      await tick();
      c.finish(item);
    }
    await done;
    expect(c.started).toEqual(items);
    expect(c.maxInFlight()).toBe(2);
  });

  it('keeps going when a session fails to start, and reports it', async () => {
    const c = controllable();
    const errors: string[] = [];
    const done = startWithLimit(['bad', 'good'], c.start, {
      concurrency: 1,
      slotTimeoutMs: 0,
      onError: (item, e) => errors.push(`${item}: ${(e as Error).message}`),
    });

    await tick();
    c.fail('bad', new Error('browser launch failed'));
    await tick();
    expect(c.started).toEqual(['bad', 'good']);
    c.finish('good');
    await done;
    expect(errors).toEqual(['bad: browser launch failed']);
  });

  it('also survives a start that throws synchronously', async () => {
    const started: string[] = [];
    const errors: string[] = [];
    await startWithLimit(
      ['x', 'y'],
      (item) => {
        started.push(item);
        if (item === 'x') throw new Error('sync boom');
        return Promise.resolve();
      },
      {
        concurrency: 1,
        slotTimeoutMs: 0,
        onError: (item) => errors.push(item),
      }
    );
    expect(started).toEqual(['x', 'y']);
    expect(errors).toEqual(['x']);
  });

  it('lets the next session through when one holds its slot too long', async () => {
    jest.useFakeTimers();
    try {
      const c = controllable();
      const timedOut: string[] = [];
      const done = startWithLimit(['slow', 'next'], c.start, {
        concurrency: 1,
        slotTimeoutMs: 120000,
        onSlotTimeout: (item) => timedOut.push(item),
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(c.started).toEqual(['slow']);

      await jest.advanceTimersByTimeAsync(119999);
      expect(c.started).toEqual(['slow']);

      await jest.advanceTimersByTimeAsync(1);
      expect(timedOut).toEqual(['slow']);
      expect(c.started).toEqual(['slow', 'next']);

      // The slow start was not cancelled, only no longer waited on.
      c.finish('next');
      await done;
      c.finish('slow');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not report a timeout for a start that finished in time', async () => {
    jest.useFakeTimers();
    try {
      const timedOut: string[] = [];
      await startWithLimit(['quick'], () => Promise.resolve(), {
        concurrency: 1,
        slotTimeoutMs: 1000,
        onSlotTimeout: (item) => timedOut.push(item),
      });
      await jest.advanceTimersByTimeAsync(5000);
      expect(timedOut).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a nonsensical limit as 1 and handles an empty list', async () => {
    const c = controllable();
    const done = startWithLimit(['a', 'b'], c.start, {
      concurrency: 0,
      slotTimeoutMs: 0,
    });
    await tick();
    expect(c.started).toEqual(['a']);
    c.finish('a');
    await tick();
    c.finish('b');
    await done;

    await expect(
      startWithLimit([], c.start, { concurrency: 2, slotTimeoutMs: 0 })
    ).resolves.toBeUndefined();
  });
});
