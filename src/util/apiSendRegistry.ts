/**
 * Messages this server sent through its own send API, remembered just long
 * enough to recognise their echo.
 *
 * WhatsApp Web reports every message the account sends as `fromMe`, whoever
 * typed it. The receiver needs only the ones a human sent from the phone (or
 * another linked device): those mean the merchant has taken the conversation
 * and the AI must stop. Our own API sends — AI replies, dashboard replies —
 * must not be forwarded as `onselfmessage`, or the receiver would read every
 * AI reply as a takeover and switch the AI off after its first answer.
 *
 * Matched on content, not message id: the send is recorded before the browser
 * is asked to send it, and WhatsApp Web emits the message event before the
 * send call returns its id, so an id-keyed lookup would always lose the race.
 * Newer WhatsApp Web payloads can also arrive without any id at all. The chat
 * is deliberately not part of the key: WhatsApp may report a chat we sent to by
 * phone number under the contact's LID, and a mismatch there would forward our
 * own reply as a human one. The cost is that a human sending the exact text the
 * API sent in the last few minutes is not forwarded — harmless (the next
 * different message is).
 *
 * In memory only. A restart between a send and its echo forwards that one echo;
 * the receiver still drops it when the message id is already on file.
 */
const TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, Map<string, number[]>>();

export type SendKind = 'text' | 'media' | 'location';

export function sendFingerprint(kind: SendKind, text: unknown): string {
  const normalised = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  return `${kind}:${normalised}`;
}

/**
 * Fingerprint of a send request, by route, or null for routes whose echo we
 * do not track.
 *
 * @param {string} path Request path, e.g. `/api/s1/send-message`.
 * @param {any} body Request body.
 * @return {string | null} The fingerprint the echo will carry.
 */
export function fingerprintOfRequest(path: string, body: any): string | null {
  const route = String(path ?? '')
    .split('/')
    .pop();
  switch (route) {
    case 'send-message':
    case 'send-reply':
      return sendFingerprint('text', body?.message);
    case 'send-file':
    case 'send-file-base64':
    case 'send-image':
      return sendFingerprint('media', body?.message || body?.caption);
    case 'send-voice':
    case 'send-voice-base64':
      return sendFingerprint('media', '');
    case 'send-location':
      return sendFingerprint(
        'location',
        `${Number(body?.lat)},${Number(body?.lng)}`
      );
    default:
      return null;
  }
}

/**
 * Fingerprint of a message as WhatsApp Web reports it.
 *
 * @param {any} message wppconnect message object.
 * @return {string} The fingerprint to look up.
 */
export function fingerprintOfMessage(message: any): string {
  if (message?.type === 'chat') return sendFingerprint('text', message.body);
  if (message?.type === 'location')
    return sendFingerprint(
      'location',
      `${Number(message.lat)},${Number(message.lng)}`
    );
  return sendFingerprint('media', message?.caption);
}

function prune(bySession: Map<string, number[]>, now: number): void {
  for (const [fingerprint, times] of bySession) {
    const fresh = times.filter((t) => now - t < TTL_MS);
    if (fresh.length) bySession.set(fingerprint, fresh);
    else bySession.delete(fingerprint);
  }
}

export function recordApiSend(
  session: string,
  fingerprint: string,
  now = Date.now()
): void {
  if (!session) return;
  const bySession = pending.get(session) ?? new Map<string, number[]>();
  prune(bySession, now);
  bySession.set(fingerprint, [...(bySession.get(fingerprint) ?? []), now]);
  pending.set(session, bySession);
}

/**
 * Was this message sent through our API? Consumes one recorded send, so two
 * identical API sends account for exactly two echoes.
 *
 * @param {string} session Session name.
 * @param {string} fingerprint Fingerprint of the echoed message.
 * @param {number} now Epoch ms (overridable for tests).
 * @return {boolean} True when the echo is ours.
 */
export function consumeApiSend(
  session: string,
  fingerprint: string,
  now = Date.now()
): boolean {
  const bySession = pending.get(session);
  if (!bySession) return false;
  prune(bySession, now);
  const times = bySession.get(fingerprint);
  if (!times?.length) return false;
  times.shift();
  if (!times.length) bySession.delete(fingerprint);
  return true;
}

/**
 * Express middleware for the send routes: remember the send before the
 * controller hands it to the browser. Mounted after statusConnection, which
 * has expanded `phone` into one entry per recipient; each recipient produces
 * its own echo.
 */
export function rememberApiSend(req: any, _res: any, next: () => void) {
  const fingerprint = fingerprintOfRequest(req.path, req.body);
  if (fingerprint) {
    const recipients = Array.isArray(req.body?.phone)
      ? req.body.phone.length
      : 1;
    for (let i = 0; i < recipients; i++)
      recordApiSend(req.session, fingerprint);
  }
  next();
}
