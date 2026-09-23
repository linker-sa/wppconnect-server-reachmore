import {
  pickSessionToRecycle,
  recycleSession,
  SessionSnapshot,
  startSessionRecycler,
} from '../sessionRecycler';

/**
 * The recycler closes and reopens a bloated session to reclaim memory without
 * a QR re-scan. Because a recycle drops the session for ~30s, every guardrail
 * matters: only over-threshold, only idle, never the last connected tenant,
 * one at a time. These pin all four.
 */
const POLICY = { thresholdMb: 2200, minIdleMs: 90000, keepConnectedFloor: 1 };
const snap = (o: Partial<SessionSnapshot>): SessionSnapshot => ({
  session: 's',
  memMb: 0,
  idleMs: 0,
  connected: true,
  ...o,
});

describe('pickSessionToRecycle', () => {
  it('picks an idle, connected session over the threshold', () => {
    const target = pickSessionToRecycle(
      [
        snap({ session: 'a', memMb: 2500, idleMs: 120000 }),
        snap({ session: 'b', memMb: 900, idleMs: 120000 }),
      ],
      POLICY
    );
    expect(target).toBe('a');
  });

  it('picks the hungriest when several qualify', () => {
    const target = pickSessionToRecycle(
      [
        snap({ session: 'a', memMb: 2300, idleMs: 120000 }),
        snap({ session: 'b', memMb: 2900, idleMs: 120000 }),
        snap({ session: 'c', memMb: 2600, idleMs: 120000 }),
      ],
      POLICY
    );
    expect(target).toBe('b');
  });

  it('never recycles a session that is below the threshold', () => {
    expect(
      pickSessionToRecycle(
        [
          snap({ session: 'a', memMb: 2100, idleMs: 999999 }),
          snap({ session: 'b', memMb: 1000, idleMs: 999999 }),
        ],
        POLICY
      )
    ).toBeNull();
  });

  it('never recycles a session that is still busy', () => {
    expect(
      pickSessionToRecycle(
        [
          snap({ session: 'a', memMb: 3000, idleMs: 5000 }),
          snap({ session: 'b', memMb: 2800, idleMs: 89999 }),
        ],
        POLICY
      )
    ).toBeNull();
  });

  it('never recycles the last connected session (keepConnectedFloor)', () => {
    // One connected (over threshold, idle) + one disconnected: must not act.
    expect(
      pickSessionToRecycle(
        [
          snap({ session: 'a', memMb: 3000, idleMs: 120000, connected: true }),
          snap({ session: 'b', memMb: 3000, idleMs: 120000, connected: false }),
        ],
        POLICY
      )
    ).toBeNull();
  });

  it('acts once there are two connected sessions', () => {
    expect(
      pickSessionToRecycle(
        [
          snap({ session: 'a', memMb: 3000, idleMs: 120000, connected: true }),
          snap({ session: 'b', memMb: 2400, idleMs: 120000, connected: true }),
        ],
        POLICY
      )
    ).toBe('a');
  });

  it('ignores a disconnected session even when it is the biggest', () => {
    const target = pickSessionToRecycle(
      [
        snap({
          session: 'dead',
          memMb: 5000,
          idleMs: 999999,
          connected: false,
        }),
        snap({ session: 'a', memMb: 2400, idleMs: 120000, connected: true }),
        snap({ session: 'b', memMb: 800, idleMs: 120000, connected: true }),
      ],
      POLICY
    );
    expect(target).toBe('a');
  });

  it('returns null for no sessions', () => {
    expect(pickSessionToRecycle([], POLICY)).toBeNull();
  });
});

describe('recycleSession', () => {
  const baseDeps = () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    serverOptions: { webhook: {} } as any,
    io: {} as any,
  });

  it('closes the client, resets it, then reopens via opendata', () => {
    const order: string[] = [];
    const client = {
      page: {},
      status: 'CONNECTED',
      close: jest.fn(async () => {
        order.push('close');
      }),
    };
    const clients: Record<string, any> = { s: client };
    const opendata = jest.fn(async (_req: any, session: string) => {
      order.push(`open:${session}`);
      // createSessionUtil would repopulate the client; emulate it.
      clients[session] = { page: {}, status: 'CONNECTED', session };
    });

    return recycleSession('s', {
      ...baseDeps(),
      clients,
      createUtil: () => ({ opendata }),
    }).then((ok) => {
      expect(ok).toBe(true);
      expect(order).toEqual(['close', 'open:s']);
      expect(opendata).toHaveBeenCalledTimes(1);
    });
  });

  it('does nothing for a session with no live browser', async () => {
    const opendata = jest.fn();
    const ok = await recycleSession('gone', {
      ...baseDeps(),
      clients: { gone: { status: null } },
      createUtil: () => ({ opendata }),
    });
    expect(ok).toBe(false);
    expect(opendata).not.toHaveBeenCalled();
  });

  it('reports failure and does not reopen if close throws', async () => {
    const opendata = jest.fn();
    const deps = baseDeps();
    const ok = await recycleSession('s', {
      ...deps,
      clients: {
        s: {
          page: {},
          close: jest.fn(async () => Promise.reject(new Error('boom'))),
        },
      },
      createUtil: () => ({ opendata }),
    });
    expect(ok).toBe(false);
    expect(opendata).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalled();
  });
});

describe('startSessionRecycler', () => {
  const deps = () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    serverOptions: { webhook: {} } as any,
    io: {} as any,
  });

  it('is disabled when the interval is 0', () => {
    const timer = startSessionRecycler(deps(), { intervalMs: 0 });
    expect(timer).toBeNull();
  });

  it('recycles the bloated idle session on a tick', async () => {
    jest.useFakeTimers();
    try {
      const closed: string[] = [];
      const opened: string[] = [];
      const mkClient = (status: string) => ({
        page: {},
        status,
        close: jest.fn(async () => {
          closed.push('x');
        }),
      });
      const clients: Record<string, any> = {
        big: mkClient('CONNECTED'),
        small: mkClient('CONNECTED'),
      };
      const timer = startSessionRecycler(
        {
          ...deps(),
          clients,
          memoryOf: () =>
            new Map([
              ['big', 3000],
              ['small', 800],
            ]),
          idleOf: () => 120000,
          createUtil: () => ({
            opendata: async (_req: any, session: string) => {
              opened.push(session);
              clients[session] = { page: {}, status: 'CONNECTED', session };
            },
          }),
        },
        {
          intervalMs: 1000,
          policy: {
            thresholdMb: 2200,
            minIdleMs: 90000,
            keepConnectedFloor: 1,
          },
        }
      );
      expect(timer).not.toBeNull();

      await jest.advanceTimersByTimeAsync(1000);
      // let the async tick settle
      await Promise.resolve();
      await Promise.resolve();

      expect(closed).toEqual(['x']);
      expect(opened).toEqual(['big']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not recycle when nothing is over threshold', async () => {
    jest.useFakeTimers();
    try {
      const opened: string[] = [];
      const clients: Record<string, any> = {
        a: { page: {}, status: 'CONNECTED', close: jest.fn() },
        b: { page: {}, status: 'CONNECTED', close: jest.fn() },
      };
      startSessionRecycler(
        {
          ...deps(),
          clients,
          memoryOf: () =>
            new Map([
              ['a', 1200],
              ['b', 900],
            ]),
          idleOf: () => 999999,
          createUtil: () => ({
            opendata: async (_r: any, s: string) => void opened.push(s),
          }),
        },
        {
          intervalMs: 1000,
          policy: { thresholdMb: 2200, minIdleMs: 1, keepConnectedFloor: 1 },
        }
      );
      await jest.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
      expect(opened).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
