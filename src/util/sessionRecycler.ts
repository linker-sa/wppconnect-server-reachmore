import { Server as Socket } from 'socket.io';
import { Logger } from 'winston';

import { ServerOptions } from '../types/ServerOptions';
import { perSessionMemoryMb } from './resourceMonitor';
import { msSinceActivity } from './sessionActivity';
import { clientsArray } from './sessionUtil';

/**
 * Recycle a session whose browser has bloated, without a QR re-scan.
 *
 * WhatsApp Web + Chromium sit at a high but stable baseline (~1.6 GB for a
 * heavy account, measured on prod 437 over 52 days); they do not leak steadily.
 * What does happen is transient growth on reconnects, WhatsApp Web version
 * bumps and large media — and with many sessions sharing one container those
 * peaks can stack past the memory limit and OOM-kill *every* tenant at once.
 *
 * The cure is to close and reopen just the one session that has grown too big.
 * `client.close()` shuts the browser but keeps the token file and Chromium
 * profile on the volume, so the reopen restores the session from disk with no
 * QR (the same path a redeploy takes, ~30s). `logout()` is never used — that
 * unpairs and would force a scan.
 *
 * Guardrails, because this drops a session for ~30s:
 *  - only a session actually over RECYCLE_MEMORY_THRESHOLD_MB,
 *  - only when it has been idle for RECYCLE_MIN_IDLE_MS (no message traffic),
 *  - never the last connected session (a lone tenant is never taken down),
 *  - one at a time, and never while another recycle is in flight.
 *
 * All four are configurable; setting the interval to 0 disables the worker.
 */
export const RECYCLE_CHECK_INTERVAL_MS = intEnv(
  'RECYCLE_CHECK_INTERVAL_MS',
  120000,
  0
);
export const RECYCLE_MEMORY_THRESHOLD_MB = intEnv(
  'RECYCLE_MEMORY_THRESHOLD_MB',
  2200,
  1
);
export const RECYCLE_MIN_IDLE_MS = intEnv('RECYCLE_MIN_IDLE_MS', 90000, 0);

export interface SessionSnapshot {
  session: string;
  memMb: number;
  idleMs: number;
  connected: boolean;
}

export interface RecyclePolicy {
  thresholdMb: number;
  minIdleMs: number;
  /**
   * Never recycle when this many or fewer sessions are connected, so a single
   * live tenant is never taken offline by the recycler. Default 1.
   */
  keepConnectedFloor: number;
}

/**
 * Choose the one session to recycle now, or null.
 *
 * Pure and total: the worker builds the snapshots, this decides. It picks the
 * hungriest eligible session so the biggest offender goes first, and returns
 * null unless recycling is both safe and worthwhile.
 *
 * @param {SessionSnapshot[]} snapshots One entry per known session.
 * @param {RecyclePolicy} policy Thresholds.
 * @return {string | null} Session to recycle, or null.
 */
export function pickSessionToRecycle(
  snapshots: SessionSnapshot[],
  policy: RecyclePolicy
): string | null {
  const connectedCount = snapshots.filter((s) => s.connected).length;
  // Recycling one drops it, so never act while at or below the floor.
  if (connectedCount <= policy.keepConnectedFloor) return null;

  const eligible = snapshots.filter(
    (s) =>
      s.connected &&
      s.memMb >= policy.thresholdMb &&
      s.idleMs >= policy.minIdleMs
  );
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => b.memMb - a.memMb);
  return eligible[0].session;
}

interface RecyclerDeps {
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  serverOptions: ServerOptions;
  io: Socket;
  clients?: Record<string, any>;
  memoryOf?: () => Map<string, number>;
  idleOf?: (session: string) => number;
  createUtil?: () => { opendata: (req: any, session: string) => Promise<void> };
  now?: () => number;
}

/**
 * Close one session's browser and reopen it from disk.
 *
 * The reopen uses a minimal request: an empty body, plus the real
 * serverOptions/logger/io. The webhook URL and config are restored from the
 * token file by the token store (createSessionUtil.decodeFunction), exactly as
 * on a normal boot, so nothing about the session's wiring is lost.
 *
 * @param {string} session Session to recycle.
 * @param {RecyclerDeps} deps Injected collaborators.
 * @return {Promise<boolean>} true if it closed and reopened without throwing.
 */
export async function recycleSession(
  session: string,
  deps: RecyclerDeps
): Promise<boolean> {
  const clients = deps.clients ?? clientsArray;
  const client = clients[session] as any;
  if (!client || !client.page) return false;

  const memBefore = deps.memoryOf?.().get(session);
  deps.logger.info(
    `[recycle] ${session}: closing to reclaim memory` +
      (memBefore ? ` (${memBefore} MB)` : '')
  );

  try {
    await client.close();
  } catch (error) {
    deps.logger.error(`[recycle] ${session}: close failed: ${error}`);
    return false;
  }

  // Match closeSession: a null status lets createSessionUtil start it again.
  clients[session] = { status: null, session } as any;

  // opendata only reads serverOptions/logger/io/body from the request; the
  // rest of Express's Request is never touched on this path.
  const req = {
    serverOptions: deps.serverOptions,
    logger: deps.logger,
    io: deps.io,
    body: {},
  } as any;
  try {
    const util = deps.createUtil?.() ?? defaultCreateUtil();
    await util.opendata(req, session);
    deps.logger.info(`[recycle] ${session}: reopened from stored session`);
    return true;
  } catch (error) {
    deps.logger.error(`[recycle] ${session}: reopen failed: ${error}`);
    return false;
  }
}

/**
 * Start the periodic recycler.
 *
 * @param {RecyclerDeps} deps Injected collaborators.
 * @param {object} options Interval/policy overrides.
 * @return {NodeJS.Timeout | null} The timer (unref'd), or null when disabled.
 */
export function startSessionRecycler(
  deps: RecyclerDeps,
  {
    intervalMs = RECYCLE_CHECK_INTERVAL_MS,
    policy = {
      thresholdMb: RECYCLE_MEMORY_THRESHOLD_MB,
      minIdleMs: RECYCLE_MIN_IDLE_MS,
      keepConnectedFloor: 1,
    },
  }: { intervalMs?: number; policy?: RecyclePolicy } = {}
): NodeJS.Timeout | null {
  if (!(intervalMs > 0)) return null;

  let recycling = false;
  const clients = deps.clients ?? clientsArray;
  const memoryOf = deps.memoryOf ?? (() => perSessionMemoryMb(clients));
  const idleOf = deps.idleOf ?? ((s: string) => msSinceActivity(s));
  const now = deps.now ?? Date.now;

  const tick = async () => {
    if (recycling) return; // never overlap a recycle with the next check
    let mem: Map<string, number>;
    try {
      mem = memoryOf();
    } catch (error) {
      deps.logger.warn(`[recycle] memory read failed: ${error}`);
      return;
    }

    const snapshots: SessionSnapshot[] = Object.keys(clients).map(
      (session) => ({
        session,
        memMb: mem.get(session) ?? 0,
        idleMs: idleOf(session),
        connected: (clients[session] as any)?.status === 'CONNECTED',
      })
    );

    const target = pickSessionToRecycle(snapshots, policy);
    if (!target) return;

    recycling = true;
    const started = now();
    try {
      const ok = await recycleSession(target, { ...deps, memoryOf });
      if (ok)
        deps.logger.info(`[recycle] ${target}: done in ${now() - started}ms`);
    } finally {
      recycling = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return timer;
}

/**
 * Build a real CreateSessionUtil, required lazily.
 *
 * createSessionUtil <-> sessionController is a circular import; pulling it at
 * module load breaks whichever module imports the recycler first. Requiring it
 * only when a recycle actually runs sidesteps the cycle.
 */
function defaultCreateUtil(): {
  opendata: (req: any, session: string) => Promise<void>;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const CreateSessionUtil = require('./createSessionUtil').default;
  return new CreateSessionUtil();
}

function intEnv(name: string, fallback: number, min: number): number {
  const value = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}
