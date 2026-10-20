import { closeSession, logOutSession } from '../sessionController';

jest.mock('../../util/manageSession', () => ({ __esModule: true }));
jest.mock('../../util/getAllTokens', () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../util/functions', () => ({
  __esModule: true,
  ...jest.requireActual('../../util/functions'),
  callWebHook: jest.fn(),
}));

const { clientsArray } = jest.requireActual('../../util/sessionUtil') as {
  clientsArray: Record<string, any>;
};
const { callWebHook } = jest.requireMock('../../util/functions') as {
  callWebHook: jest.Mock;
};

/**
 * When the phone unlinks first, the session entry is already gone by the time
 * agent-functions calls logout-session then close-session. Both used to answer
 * 500 (`Cannot read properties of undefined (reading 'status')`, and
 * `InvocationInterface was not inited` from a reloading page).
 */
function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  return r;
}

const req = (session: string, client?: any) =>
  ({
    session,
    client,
    body: {},
    io: { emit: jest.fn() },
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  } as any);

beforeEach(() => {
  for (const key of Object.keys(clientsArray)) delete clientsArray[key];
  callWebHook.mockClear();
});

describe('close-session', () => {
  it('answers 200 for a session that is already gone', async () => {
    const r = res();
    await closeSession(req('wpp_gone'), r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('answers 200 for a placeholder left by an earlier close', async () => {
    clientsArray.wpp_a = { status: null };
    const r = res();
    await closeSession(req('wpp_a', clientsArray.wpp_a), r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('still closes a live session', async () => {
    const client = { status: 'CONNECTED', close: jest.fn(async () => null) };
    clientsArray.wpp_a = client;
    const r = res();
    await closeSession(req('wpp_a', client), r);
    expect(client.close).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(clientsArray.wpp_a).toBeUndefined();
  });
});

describe('logout-session', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

  it('removes the session and answers 200 when logout() throws', async () => {
    const client = {
      status: 'CONNECTED',
      config: {},
      logout: jest.fn(async () => {
        throw new Error('InvocationInterface was not inited');
      }),
      close: jest.fn(async () => null),
    };
    clientsArray.wpp_a = client;
    const r = res();
    const rq = req('wpp_a', client);
    await logOutSession(rq, r);
    await settle();
    expect(client.close).toHaveBeenCalled();
    expect(clientsArray.wpp_a).toBeUndefined();
    expect(rq.logger.warn).toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('answers 200 with no client at all, without calling the webhook', async () => {
    const r = res();
    await logOutSession(req('wpp_gone'), r);
    await settle();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(callWebHook).not.toHaveBeenCalled();
  });
});
