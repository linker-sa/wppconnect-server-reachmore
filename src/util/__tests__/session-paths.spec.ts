import path from 'path';

/**
 * Session state (token file + Chromium profile) must survive a redeploy, or
 * every deploy logs every tenant out and forces a QR re-scan. SESSION_DATA_DIR
 * puts both under one directory so a single mounted volume covers them.
 *
 * The unset case is pinned just as hard: nothing may move for an install that
 * does not opt in, or existing sessions would be orphaned by the upgrade.
 */
const load = (value?: string) => {
  jest.resetModules();
  if (value === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = value;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../sessionPaths');
};

afterAll(() => delete process.env.SESSION_DATA_DIR);

describe('sessionPaths', () => {
  it('keeps the original locations when SESSION_DATA_DIR is unset', () => {
    const p = load();
    expect(p.tokensDir).toBe('./tokens');
    expect(p.userDataDirBase).toBe('./userDataDir/');
    expect(p.tokenFilePath('wpp_437_1')).toBe(
      path.resolve(process.cwd(), 'tokens', 'wpp_437_1.data.json')
    );
  });

  it('treats a blank value as unset', () => {
    expect(load('   ').tokensDir).toBe('./tokens');
  });

  it('puts BOTH directories under the volume, so one mount covers them', () => {
    const p = load('/data');
    expect(p.tokensDir).toBe('/data/tokens');
    expect(p.userDataDirBase).toBe('/data/userDataDir/');
    expect(p.tokenFilePath('wpp_437_1')).toBe(
      '/data/tokens/wpp_437_1.data.json'
    );
  });

  it('keeps the trailing separator the profile path depends on', () => {
    // createSessionUtil builds the profile dir as `customUserDataDir + session`
    // with no join — without the separator, sessions collapse into one name.
    const p = load('/data');
    expect(p.userDataDirBase + 'wpp_437_1').toBe('/data/userDataDir/wpp_437_1');
  });

  it('resolves to a real file path, unlike the old logout path', () => {
    // Logout used `__dirname + "../../../tokens/x"` — no leading slash, so it
    // pointed inside a directory named "controller.." and never deleted the
    // token. With a volume that would resurrect a logged-out session on boot.
    const p = load('/data');
    expect(p.tokenFilePath('s')).not.toContain('..');
    expect(path.isAbsolute(p.tokenFilePath('s'))).toBe(true);
  });
});
