/*
 * Copyright 2026 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import api from 'axios';

import { callWebHook } from '../../util/functions';

jest.mock('axios', () => ({ post: jest.fn() }));

const post = api.post as jest.Mock;

function setup(options: Record<string, unknown> = {}) {
  const client = {
    session: 'test',
    config: {} as { webhook?: string },
    sendSeen: jest.fn(),
  };
  const req = {
    serverOptions: {
      mapper: { enable: false },
      webhook: {
        url: 'https://example.com/hook',
        autoDownload: false,
        readMessage: true,
        ...options,
      },
    },
    logger: { warn: jest.fn(), error: jest.fn() },
  };
  return { client, req };
}

beforeEach(() => {
  jest.useFakeTimers();
  post.mockReset();
});
afterEach(() => jest.useRealTimers());

it('does not retry HTTP responses or read-receipt failures', async () => {
  const { client, req } = setup();
  post.mockRejectedValueOnce({
    code: 'ERR_BAD_REQUEST',
    response: { status: 400 },
  });
  await callWebHook(client, req as any, 'onmessage', {});
  expect(post).toHaveBeenCalledTimes(1);
  post.mockReset().mockResolvedValue({});
  client.sendSeen.mockRejectedValue(new Error('Read receipt failed'));
  await callWebHook(client, req as any, 'onmessage', {});
  expect(post).toHaveBeenCalledTimes(1);
});

// Fork: delivery and its retries are postWebhookWithRetry, covered in
// src/util/__tests__/webhook-retry.spec.ts; upstream's retry loop is not used.
// The destination allowlist applies only once WEBHOOK_ALLOWED_URLS is set.

it('uses a session webhook URL as-is when no allowlist is configured', async () => {
  const { client, req } = setup();
  post.mockResolvedValue({});
  client.config.webhook = 'https://receiver.test/hook?qrToken=secret';
  await callWebHook(client, req as any, 'onmessage', {});
  expect(post.mock.calls[0][0]).toBe(
    'https://receiver.test/hook?qrToken=secret'
  );
});

it('rejects an unconfigured session destination before making any request', async () => {
  const { client, req } = setup({ allowedUrls: ['https://allowed.test/hook'] });
  client.config.webhook = 'http://unconfigured.test/internal';
  await callWebHook(client, req as any, 'onmessage', {});
  expect(post).not.toHaveBeenCalled();
  expect(req.logger.warn).toHaveBeenCalledTimes(1);
});

it('permits the exact global destination or an explicitly allowed session URL', async () => {
  const { client, req } = setup({ allowedUrls: ['https://allowed.test/hook'] });
  post.mockResolvedValue({});
  client.config.webhook = 'https://example.com/hook';
  await callWebHook(client, req as any, 'onmessage', {});
  client.config.webhook = 'https://allowed.test/hook';
  await callWebHook(client, req as any, 'onmessage', {});
  expect(post.mock.calls.map((call) => call[0])).toEqual([
    'https://example.com/hook',
    'https://allowed.test/hook',
  ]);
  client.config.webhook = 'https://allowed.test/hook/extra';
  await callWebHook(client, req as any, 'onmessage', {});
  expect(post).toHaveBeenCalledTimes(2);
});
