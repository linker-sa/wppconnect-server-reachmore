import CreateSessionUtil from '../createSessionUtil';
import { clientsArray } from '../sessionUtil';

jest.mock('@wppconnect-team/wppconnect', () => ({
  create: jest.fn(),
  SocketState: { CONFLICT: 'CONFLICT' },
  StatusFind: {
    autocloseCalled: 'autocloseCalled',
    disconnectedMobile: 'disconnectedMobile',
    isLogged: 'isLogged',
    qrReadSuccess: 'qrReadSuccess',
  },
}));
jest.mock('../../controller/sessionController', () => ({
  download: jest.fn(),
}));
jest.mock('../functions', () => ({
  autoDownload: jest.fn(),
  callWebHook: jest.fn(),
  startHelper: jest.fn(),
}));
jest.mock('../tokenStore/factory', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    createTokenStory: () => ({
      getToken: jest.fn().mockResolvedValue({}),
      setToken: jest.fn(),
    }),
  })),
}));
jest.mock('../sessionParking', () => ({ trackSessionStatus: jest.fn() }));

/**
 * A new pairing (staging reachmore_116, 2026-10-21): the page reports "Session
 * Unpaired" as disconnectedMobile before it shows the QR. Closing on it ended
 * the attempt, the ownership check dropped the QR, and the dashboard's
 * start-session (waitQrCode) hung until its 60 s timeout.
 */
const req = () => ({
  body: {},
  serverOptions: { createOptions: {}, webhook: {} },
  logger: { info: jest.fn(), error: jest.fn() },
});

async function start(callbacks: (options: any) => void) {
  const { create } = jest.requireMock('@wppconnect-team/wppconnect');
  create.mockImplementation(async (options: any) => {
    callbacks(options);
    throw new Error('fixture: the attempt ends here');
  });
  const util = new CreateSessionUtil();
  util.exportQR = jest.fn();
  await util.createSessionUtil(req(), clientsArray, 'wpp_new');
  return util;
}

afterEach(() => {
  delete (clientsArray as any).wpp_new;
  jest.clearAllMocks();
});

it('shows the QR to a new session after the unpaired report', async () => {
  const util = await start((options) => {
    options.statusFind('disconnectedMobile');
    options.catchQR('data:image/png;base64,qr', '', 1, 'code');
  });

  expect(util.exportQR).toHaveBeenCalledTimes(1);
});
