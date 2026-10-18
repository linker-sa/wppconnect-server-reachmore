import {
  consumeApiSend,
  fingerprintOfMessage,
  fingerprintOfRequest,
  recordApiSend,
  rememberApiSend,
} from '../apiSendRegistry';

/**
 * The receiver reads every forwarded `onselfmessage` as a human takeover, so an
 * echo of our own API send that slips through switches the AI off after its
 * first reply. These pin which echoes are ours.
 */
describe('apiSendRegistry', () => {
  const T0 = 1_000_000_000;

  it('matches a text send to its echo, once', () => {
    recordApiSend(
      's1',
      fingerprintOfRequest('/api/s1/send-message', { message: 'Hello there' })!,
      T0
    );
    const echo = fingerprintOfMessage({
      type: 'chat',
      body: 'Hello there',
      fromMe: true,
    });
    expect(consumeApiSend('s1', echo, T0 + 500)).toBe(true);
    // the same text again is a human typing it, not our echo
    expect(consumeApiSend('s1', echo, T0 + 600)).toBe(false);
  });

  it('forwards a phone reply nobody sent through the API', () => {
    recordApiSend(
      's2',
      fingerprintOfRequest('/api/s2/send-message', { message: 'AI answer' })!,
      T0
    );
    const human = fingerprintOfMessage({
      type: 'chat',
      body: 'I will call you',
      fromMe: true,
    });
    expect(consumeApiSend('s2', human, T0 + 100)).toBe(false);
  });

  it('keeps sessions apart', () => {
    recordApiSend(
      's3',
      fingerprintOfRequest('/api/s3/send-message', { message: 'hi' })!,
      T0
    );
    expect(
      consumeApiSend(
        's4',
        fingerprintOfMessage({ type: 'chat', body: 'hi' }),
        T0
      )
    ).toBe(false);
  });

  it('counts two identical sends as two echoes', () => {
    const fp = fingerprintOfRequest('/api/s5/send-reply', { message: 'ok' })!;
    recordApiSend('s5', fp, T0);
    recordApiSend('s5', fp, T0 + 1);
    const echo = fingerprintOfMessage({ type: 'chat', body: 'ok' });
    expect(consumeApiSend('s5', echo, T0 + 2)).toBe(true);
    expect(consumeApiSend('s5', echo, T0 + 3)).toBe(true);
    expect(consumeApiSend('s5', echo, T0 + 4)).toBe(false);
  });

  it('forgets a send whose echo never came after ten minutes', () => {
    recordApiSend(
      's6',
      fingerprintOfRequest('/api/s6/send-message', { message: 'late' })!,
      T0
    );
    const echo = fingerprintOfMessage({ type: 'chat', body: 'late' });
    expect(consumeApiSend('s6', echo, T0 + 10 * 60 * 1000 + 1)).toBe(false);
  });

  it('matches media by caption and location by coordinates', () => {
    recordApiSend(
      's7',
      fingerprintOfRequest('/api/s7/send-file-base64', {
        caption: 'Menu',
        base64: 'x',
      })!,
      T0
    );
    expect(
      consumeApiSend(
        's7',
        fingerprintOfMessage({ type: 'image', caption: 'Menu', body: '/9j/' }),
        T0
      )
    ).toBe(true);

    recordApiSend(
      's7',
      fingerprintOfRequest('/api/s7/send-voice-base64', { base64Ptt: 'x' })!,
      T0
    );
    expect(
      consumeApiSend('s7', fingerprintOfMessage({ type: 'ptt' }), T0)
    ).toBe(true);

    recordApiSend(
      's7',
      fingerprintOfRequest('/api/s7/send-location', {
        lat: '24.71',
        lng: 46.67,
      })!,
      T0
    );
    expect(
      consumeApiSend(
        's7',
        fingerprintOfMessage({ type: 'location', lat: 24.71, lng: '46.67' }),
        T0
      )
    ).toBe(true);
  });

  it('ignores whitespace and line-ending differences WhatsApp may introduce', () => {
    recordApiSend(
      's8',
      fingerprintOfRequest('/api/s8/send-message', {
        message: '  line1\r\nline2 ',
      })!,
      T0
    );
    expect(
      consumeApiSend(
        's8',
        fingerprintOfMessage({ type: 'chat', body: 'line1\nline2' }),
        T0
      )
    ).toBe(true);
  });

  it('does not track routes whose echo it cannot recognise', () => {
    expect(
      fingerprintOfRequest('/api/s9/send-poll-message', { name: 'q' })
    ).toBeNull();
  });

  it('records one echo per recipient from the middleware', () => {
    const next = jest.fn();
    rememberApiSend(
      {
        path: '/api/s10/send-message',
        session: 's10',
        body: { phone: ['1@c.us', '2@c.us'], message: 'promo' },
      },
      {},
      next
    );
    expect(next).toHaveBeenCalled();
    const echo = fingerprintOfMessage({ type: 'chat', body: 'promo' });
    expect(consumeApiSend('s10', echo)).toBe(true);
    expect(consumeApiSend('s10', echo)).toBe(true);
    expect(consumeApiSend('s10', echo)).toBe(false);
  });
});
