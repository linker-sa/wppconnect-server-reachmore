/*
 * Copyright 2021 WPPConnect Team
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
import { timingSafeEqual } from 'crypto';

/** The upstream sample secrets; anyone can mint session tokens with them. */
export const PUBLIC_DEFAULT_SECRETS = [
  'THISISMYSECURETOKEN',
  'THISISMYSECURECODE',
];

export function isAdmin(token: unknown, secret: string): boolean {
  if (typeof token !== 'string' || !token || !secret) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request carries the server secret: the `x-secret-key` header,
 * else the legacy `:secretkey` path segment, else the first word of
 * `Authorization`. A path secret lands in every access log, so callers should
 * send the header and put any placeholder in the path.
 */
export function requestHasSecret(
  req: {
    headers?: Record<string, string | string[] | undefined>;
    params?: Record<string, string | undefined>;
  },
  secret: string
): boolean {
  const header = req.headers?.['x-secret-key'];
  const authorization = req.headers?.authorization;
  const candidate =
    typeof header === 'string'
      ? header
      : req.params?.secretkey ??
        (typeof authorization === 'string'
          ? authorization.split(' ')[0]
          : undefined);
  return isAdmin(candidate, secret);
}
