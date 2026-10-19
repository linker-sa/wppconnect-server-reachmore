import config from '../../config';
import { backupAllSessions, restoreAllSessions } from '../miscController';
import { showAllSessions } from '../sessionController';

// jest hoists these mocks above the imports at runtime. Each factory builds
// its own jest.fn (referencing an outer const would hit the TDZ on hoist);
// the fns are read back with jest.requireMock below.
jest.mock('../../util/manageSession', () => ({
  __esModule: true,
  backupSessions: jest.fn(() => Promise.resolve(Buffer.from('zip'))),
  restoreSessions: jest.fn(() => Promise.resolve({ success: true })),
}));
jest.mock('../../util/getAllTokens', () => ({
  __esModule: true,
  default: jest.fn(() => Promise.resolve(['wpp_a', 'wpp_b'])),
}));
// manageSession pulls in the whole session stack; stub the leaves it needs.
jest.mock('../../util/sessionUtil', () => ({
  __esModule: true,
  clientsArray: {},
  deleteSessionOnArray: jest.fn(),
}));

const { backupSessions, restoreSessions } = jest.requireMock(
  '../../util/manageSession'
) as { backupSessions: jest.Mock; restoreSessions: jest.Mock };
const getAllTokens = jest.requireMock('../../util/getAllTokens')
  .default as jest.Mock;

/**
 * These three admin endpoints authenticate by comparing a secret in the URL
 * to the server secret. Each used to answer 400 on a mismatch and then fall
 * through and run anyway: backup returns every session's WhatsApp
 * credentials, restore overwrites them from an uploaded zip, show-all lists
 * every session. Reproduced against a local build 2026-09-22.
 */
function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  r.setHeader = jest.fn(() => r);
  r.send = jest.fn(() => r);
  return r;
}

beforeEach(() => {
  backupSessions.mockClear();
  restoreSessions.mockClear();
  getAllTokens.mockClear();
});

const WRONG = `${config.secretKey}_WRONG`;
const settle = () => new Promise((r) => setImmediate(r));

describe('admin endpoints reject a wrong secret without side effects', () => {
  it('backup-sessions does not read any session', async () => {
    const r = res();
    await backupAllSessions({ params: { secretkey: WRONG } } as any, r);
    await settle();
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.status).toHaveBeenCalledTimes(1);
    expect(backupSessions).not.toHaveBeenCalled();
    expect(r.send).not.toHaveBeenCalled();
  });

  it('restore-sessions does not overwrite any token', async () => {
    const r = res();
    await restoreAllSessions(
      {
        params: { secretkey: WRONG },
        file: { mimetype: 'application/zip' },
      } as any,
      r
    );
    await settle();
    expect(r.status).toHaveBeenCalledWith(400);
    expect(restoreSessions).not.toHaveBeenCalled();
  });

  it('show-all-sessions does not list sessions', async () => {
    const r = res();
    await showAllSessions(
      {
        params: { secretkey: WRONG },
        headers: {},
        serverOptions: { secretKey: config.secretKey },
      } as any,
      r
    );
    await settle();
    expect(r.status).toHaveBeenCalledWith(400);
    expect(getAllTokens).not.toHaveBeenCalled();
  });

  it('still serves show-all-sessions with the right secret', async () => {
    const r = res();
    await showAllSessions(
      {
        params: { secretkey: config.secretKey },
        headers: {},
        serverOptions: { secretKey: config.secretKey },
      } as any,
      r
    );
    await settle();
    expect(r.status).toHaveBeenCalledWith(200);
    expect(getAllTokens).toHaveBeenCalled();
  });
});
