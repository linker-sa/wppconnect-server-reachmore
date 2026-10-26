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
import { requestHasSecret } from '../secret';

const SECRET = 'a-long-random-server-secret';
const req = (
  headers: Record<string, string> = {},
  params: Record<string, string> = {}
) => ({ headers, params });

it('accepts the secret from the x-secret-key header', () => {
  expect(
    requestHasSecret(
      req({ 'x-secret-key': SECRET }, { secretkey: '-' }),
      SECRET
    )
  ).toBe(true);
});

it('still accepts the legacy path secret', () => {
  expect(requestHasSecret(req({}, { secretkey: SECRET }), SECRET)).toBe(true);
});

it('lets the header decide when both are sent', () => {
  expect(
    requestHasSecret(
      req({ 'x-secret-key': 'wrong' }, { secretkey: SECRET }),
      SECRET
    )
  ).toBe(false);
});

it('accepts the first word of Authorization when nothing else is sent', () => {
  expect(
    requestHasSecret(req({ authorization: `${SECRET} extra` }), SECRET)
  ).toBe(true);
});

it('refuses a wrong, missing or empty secret', () => {
  expect(requestHasSecret(req({}, { secretkey: 'wrong' }), SECRET)).toBe(false);
  expect(requestHasSecret(req(), SECRET)).toBe(false);
  expect(requestHasSecret(req({}, { secretkey: '' }), '')).toBe(false);
});

it('refuses to start without a real secret', async () => {
  const { initServer } = await import('../../index');
  expect(() => initServer({ secretKey: '' })).toThrow(/SECRET_KEY/);
  expect(() => initServer({ secretKey: 'THISISMYSECURETOKEN' })).toThrow(
    /SECRET_KEY/
  );
});
