/**
 * Last time each session saw real message traffic.
 *
 * The recycler (sessionRecycler.ts) may close and reopen a bloated session's
 * browser to reclaim memory. That is only safe while the session is idle — in
 * the ~30s a recycle takes, an in-flight conversation would stall. "Idle" here
 * means no inbound or outbound *message* for a while; acks, presence and
 * status events do not count, or a busy chat would never look idle.
 *
 * Recorded from createSessionUtil's message listeners. Kept in memory only: a
 * restart clears it, and a freshly started session is treated as active until
 * it has been quiet long enough, which is the safe default.
 */
const lastActivityMs = new Map<string, number>();

/**
 * Note that a session just handled a message.
 *
 * @param {string} session Session name.
 * @param {number} now Epoch ms (overridable for tests).
 * @return {void}
 */
export function recordActivity(session: string, now = Date.now()): void {
  if (session) lastActivityMs.set(session, now);
}

/**
 * Milliseconds since a session last handled a message.
 *
 * A session never seen is reported as active right now (0), not as infinitely
 * idle, so the recycler never touches a session it has no history for.
 *
 * @param {string} session Session name.
 * @param {number} now Epoch ms (overridable for tests).
 * @return {number} Idle time in ms.
 */
export function msSinceActivity(session: string, now = Date.now()): number {
  const last = lastActivityMs.get(session);
  if (last === undefined) {
    lastActivityMs.set(session, now);
    return 0;
  }
  return Math.max(0, now - last);
}

/** Drop a session's record (e.g. when it is cleared). Test/ops helper. */
export function forgetActivity(session: string): void {
  lastActivityMs.delete(session);
}
