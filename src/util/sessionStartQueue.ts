/**
 * Start sessions a few at a time instead of all at once.
 *
 * Every session is its own Chromium running WhatsApp Web. Loading one is the
 * expensive moment: measured locally, a single load peaks at ~530 MB and
 * ~1.3-1.6 CPU cores before settling at ~400 MB. On boot the server used to
 * launch every stored session in the same tick, so the peak scaled with the
 * tenant count: 4 sessions at once already reached 2.27 GB and 3.5 cores.
 *
 * With many tenants on one container that peak is what fails. Loads contend
 * for CPU, each takes longer, a slow restore can overrun `deviceSyncTimeout`,
 * and a container that runs out of memory restarts and hits the same wall
 * again. Bounding how many start at once bounds the peak by the limit, not by
 * the number of tenants.
 */

/** How many sessions may be starting at the same time. */
export const START_CONCURRENCY = positiveInt(
  process.env.SESSION_START_CONCURRENCY,
  2
);

/**
 * How long one start may hold its slot before the next one is let through.
 *
 * A start "finishes" when wppconnect's `create()` settles, which for a linked
 * account is after the initial sync, which can take minutes on a large
 * history. The heavy part is the page load before that, so a slow sync must
 * not stall every tenant queued behind it. The start keeps running after its
 * slot is released; only the queue moves on. 0 disables the timeout.
 */
export const START_SLOT_TIMEOUT_MS = nonNegativeInt(
  process.env.SESSION_START_SLOT_TIMEOUT_MS,
  120000
);

export interface StartQueueOptions {
  concurrency: number;
  slotTimeoutMs: number;
  onError?: (item: string, error: unknown) => void;
  onSlotTimeout?: (item: string) => void;
}

/**
 * Run `start` for every item, at most `concurrency` at a time.
 *
 * A failed start is reported through `onError` and never stops the rest: one
 * tenant's broken session must not keep the others offline.
 *
 * @param {string[]} items Session names, in the order to start them.
 * @param {(item: string) => Promise<unknown>} start Starts one session.
 * @param {StartQueueOptions} options Limits and callbacks.
 * @return {Promise<void>} Resolves once every start has finished or timed out.
 */
export async function startWithLimit(
  items: string[],
  start: (item: string) => Promise<unknown>,
  options: StartQueueOptions
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency) || 1);
  let next = 0;

  const holdSlot = async (item: string) => {
    const run = Promise.resolve()
      .then(() => start(item))
      .catch((error) => options.onError?.(item, error));

    if (!(options.slotTimeoutMs > 0)) return run;

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), options.slotTimeoutMs);
    });
    const outcome = await Promise.race([run.then(() => false), timedOut]);
    clearTimeout(timer);
    if (outcome) options.onSlotTimeout?.(item);
  };

  const worker = async () => {
    while (next < items.length) await holdSlot(items[next++]);
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
