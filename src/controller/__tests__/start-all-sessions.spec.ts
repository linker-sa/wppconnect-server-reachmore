import { startAllSessions } from '../sessionController';

jest.mock('../../util/getAllTokens', () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve(['s1', 's2', 's3'])),
}));
// sessionController builds a CreateSessionUtil at load time, so the mock
// has to be self-contained (jest hoists this above the import).
jest.mock('../../util/createSessionUtil', () => {
  const opendata = jest.fn(() => Promise.resolve());
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({ opendata })),
    opendata,
  };
});

const mockOpendata = jest.requireMock('../../util/createSessionUtil')
  .opendata as jest.Mock;

/**
 * `POST /api/:secretkey/start-all` used to answer 400 for a wrong secret and
 * then fall through: every stored session was started anyway, and the second
 * response threw "Cannot set headers after they are sent to the client".
 * Reproduced against a local build on 2026-09-22.
 */
function fakeReqRes(secretkey: string) {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req: any = {
    params: { secretkey },
    headers: {},
    serverOptions: { secretKey: 'right-secret' },
    logger,
  };
  return { req, res, logger };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mockOpendata.mockClear());

describe('startAllSessions', () => {
  it('rejects a wrong secret without starting any session', async () => {
    const { req, res } = fakeReqRes('wrong-secret');

    await startAllSessions(req, res);
    await settle();

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockOpendata).not.toHaveBeenCalled();
  });

  it('starts every stored session with the right secret', async () => {
    const { req, res } = fakeReqRes('right-secret');

    await startAllSessions(req, res);
    await settle();
    await settle();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockOpendata.mock.calls.map((call: any[]) => call[1])).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('refuses a second run while the first is still starting sessions', async () => {
    const pending: Array<() => void> = [];
    mockOpendata.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve))
    );
    const first = fakeReqRes('right-secret');
    await startAllSessions(first.req, first.res);

    const second = fakeReqRes('right-secret');
    await startAllSessions(second.req, second.res);
    expect(second.res.status).toHaveBeenCalledWith(409);

    mockOpendata.mockImplementation(() => Promise.resolve());
    pending.forEach((resolve) => resolve());
    for (let i = 0; i < 10; i++) await settle();

    const third = fakeReqRes('right-secret');
    await startAllSessions(third.req, third.res);
    expect(third.res.status).toHaveBeenCalledWith(201);
  });
});
