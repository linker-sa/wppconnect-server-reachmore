import CreateSessionUtil from '../createSessionUtil';
import { trackSessionStatus } from '../sessionParking';
import { clientsArray } from '../sessionUtil';

jest.mock('@wppconnect-team/wppconnect', () => ({
  create: jest.fn(),
  SocketState: { CONFLICT: 'CONFLICT' },
  StatusFind: {
    autocloseCalled: 'autocloseCalled',
    disconnectedMobile: 'disconnectedMobile',
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
 * A never-linked session gives up at the QR screen with autocloseCalled, which
 * ends the attempt's ownership; the browserClose that parking waits for comes
 * after. Upstream's ownership check returns early for such late callbacks, so
 * parking has to be fed before it or unpaired sessions are never parked.
 */
it('feeds parking the browserClose that follows autocloseCalled', async () => {
  const { create } = jest.requireMock('@wppconnect-team/wppconnect');
  create.mockImplementation(async (options: any) => {
    options.statusFind('autocloseCalled');
    options.statusFind('browserClose');
    throw new Error('fixture: the attempt ends here');
  });
  const req = {
    body: {},
    serverOptions: { createOptions: {}, webhook: {} },
    logger: { info: jest.fn(), error: jest.fn() },
  };

  await new CreateSessionUtil().createSessionUtil(req, clientsArray, 'wpp_x');

  expect(
    (trackSessionStatus as jest.Mock).mock.calls.map((call) => call[1])
  ).toEqual(['autocloseCalled', 'browserClose']);
  delete (clientsArray as any).wpp_x;
});
