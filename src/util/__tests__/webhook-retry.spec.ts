import api from 'axios';

import { postWebhookWithRetry } from '../functions';

jest.mock('axios');

/**
 * Webhook delivery used to be `api.post(...).catch(log)` — fire-and-forget.
 * One failed POST lost the message permanently: wppconnect never redelivers,
 * nothing is queued, and the only trace was a single warn line on the server.
 * A receiver cold start or a transient 5xx silently cost a real customer
 * message, undiagnosable afterwards because the receiving side has no record
 * that anything was ever sent.
 *
 * Observed on prod 2026-09-17: a conversation was created at 12:30:24 with no
 * inbound message stored and no receiveMessage invocation anywhere in the
 * logs — the POST simply never landed, and the message was gone.
 *
 * These tests pin what is retried and what is not. Retrying a deterministic
 * 4xx (a 403 from webhook auth, say) would just hammer the receiver without
 * ever saving the message, so those must fail fast and loudly instead.
 */
const post = api.post as unknown as jest.Mock;

const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const reqWith = (log: ReturnType<typeof logger>) => ({ logger: log } as any);
const payload = { event: 'onmessage', session: 'wpp_437_1785661956925' };

// Backoff sleeps for real; keep the clock out of it.
beforeAll(() => jest.useFakeTimers({ doNotFake: ['performance'] }));
afterAll(() => jest.useRealTimers());
beforeEach(() => post.mockReset());

/** Run `p` while letting every pending backoff timer fire. */
async function withTimers<T>(p: Promise<T>): Promise<T> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    jest.runOnlyPendingTimers();
  }
  return p;
}

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe('postWebhookWithRetry', () => {
  it('delivers on the first attempt without retrying', async () => {
    post.mockResolvedValue({ status: 200 });
    const log = logger();

    await expect(
      postWebhookWithRetry('http://hook', payload, reqWith(log))
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('recovers a message that would previously have been lost', async () => {
    // The real scenario: the receiver is cold, the first POST fails, the retry
    // lands. Before this change that message was gone.
    post
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue({ status: 200 });
    const log = logger();

    await expect(
      withTimers(postWebhookWithRetry('http://hook', payload, reqWith(log)))
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('attempt 2'));
  });

  it.each([
    ['a network failure with no response', new Error('socket hang up')],
    ['429 rate limiting', httpError(429)],
    ['500', httpError(500)],
    ['503', httpError(503)],
  ])('retries %s', async (_label, err) => {
    post.mockRejectedValue(err);
    const log = logger();

    await expect(
      withTimers(postWebhookWithRetry('http://hook', payload, reqWith(log)))
    ).resolves.toBe(false);
    expect(post).toHaveBeenCalledTimes(5);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('message lost')
    );
  });

  it.each([
    ['403 from webhook authentication', 403],
    ['400', 400],
    ['404', 404],
  ])('does NOT retry %s', async (_label, status) => {
    // Deterministic rejections fail identically every time; retrying only adds
    // load. They must surface as an error rather than be swallowed.
    post.mockRejectedValue(httpError(status));
    const log = logger();

    await expect(
      postWebhookWithRetry('http://hook', payload, reqWith(log))
    ).resolves.toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('not retrying')
    );
  });

  it('names the event and session when a message is lost, so it can be chased', async () => {
    post.mockRejectedValue(httpError(500));
    const log = logger();

    await withTimers(
      postWebhookWithRetry('http://hook', payload, reqWith(log))
    );

    const message = log.error.mock.calls[0][0] as string;
    expect(message).toContain('onmessage');
    expect(message).toContain('wpp_437_1785661956925');
  });
});
