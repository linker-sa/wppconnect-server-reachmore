import fs from 'fs';
import path from 'path';

import { userDataDirBase } from './sessionPaths';

/**
 * Periodically log how much memory each session's Chromium is using.
 *
 * All tenants share one container, so sizing it (and deciding how many
 * tenants fit) needs the per-session cost of a *linked* account with real
 * history, which cannot be measured locally. This line makes it readable from
 * the platform logs:
 *
 *   [resources] container 1.84 GB / 8.00 GB · node 171 MB · 2 browser(s):
 *   wpp_reachmore_195_1789920296968 398 MB, wpp_reachmore_71_1789918239024 412 MB
 *
 * Memory is PSS (proportional set size) summed over each browser's process
 * tree, so pages Chromium processes share are counted once in total rather
 * than once per process.
 *
 * RESOURCE_LOG_INTERVAL_MS sets the period (default 5 minutes; 0 disables).
 */
export const RESOURCE_LOG_INTERVAL_MS = (() => {
  const value = Number.parseInt(
    String(process.env.RESOURCE_LOG_INTERVAL_MS ?? '').trim(),
    10
  );
  return Number.isFinite(value) && value >= 0 ? value : 300000;
})();

interface ProcessTable {
  children: Map<number, number[]>;
  /** Root (browser) process of each session's Chromium, by session name. */
  browsers: Map<string, number>;
}

/**
 * One pass over procfs: the parent/child map, and every Chromium browser
 * process keyed by the session whose profile it runs.
 *
 * Browsers are found by their `--user-data-dir` argument rather than through
 * the session's client object: the server only stores the client once
 * wppconnect's `create()` resolves, i.e. after login and sync, so a browser
 * that is loading, syncing or waiting on a QR code (the heaviest moments)
 * would be invisible. A Chromium left running after its session was closed
 * shows up here too, which is exactly what should be noticed.
 *
 * Only profiles under `profileBase` count: anything else (a developer's own
 * Chrome when running locally) is not this server's to report or to kill.
 *
 * @param {string} procRoot Mount point of procfs; overridable for tests.
 * @param {string} profileBase Directory the session profiles live in.
 * @return {ProcessTable} The table.
 */
export function scanProcesses(
  procRoot = '/proc',
  profileBase = userDataDirBase
): ProcessTable {
  const base = path.resolve(profileBase);
  const children = new Map<number, number[]>();
  const browsers = new Map<string, number>();
  for (const entry of safeReaddir(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const ppid = parentPid(procRoot, pid);
    if (ppid === null) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);

    const profile = browserProfile(procRoot, pid);
    if (profile && path.dirname(path.resolve(profile)) === base)
      browsers.set(path.basename(profile), pid);
  }
  return { children, browsers };
}

/**
 * Memory of a process and all of its descendants, in kB.
 *
 * @param {number} rootPid Root of the tree (the browser process).
 * @param {string} procRoot Mount point of procfs; overridable for tests.
 * @param {Map<number, number[]>} children Parent/child map from `scanProcesses`.
 * @return {number} Summed PSS in kB (RSS where PSS is unavailable).
 */
/**
 * The root Chromium PID of a wppconnect client, or null.
 *
 * Taken straight from the browser handle (`client.page.browser().process()`),
 * the same source the library's own `getPID()` uses. This is far more reliable
 * than matching `--user-data-dir` in /proc cmdlines: on some builds (observed
 * on the Railway Alpine image) Chromium rewrites the main process's cmdline
 * and the profile match finds nothing.
 *
 * @param {any} client A clientsArray entry.
 * @return {number | null} The browser PID, or null if not running.
 */
export function browserPid(client: any): number | null {
  try {
    const pid = client?.page?.browser?.()?.process?.()?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Per-session Chromium memory, in MB, keyed by session name.
 *
 * Roots come from the live client objects (reliable), and each root's whole
 * process tree is summed via the /proc parent map. A session with no running
 * browser (still starting, closed) is skipped. When `clients` is omitted it
 * falls back to the profile-dir scan (used by tests).
 *
 * @param {Record<string, any>} clients The server's `clientsArray`.
 * @param {string} procRoot Mount point of procfs; overridable for tests.
 * @return {Map<string, number>} session name -> resident MB (PSS).
 */
export function perSessionMemoryMb(
  clients?: Record<string, any>,
  procRoot = '/proc'
): Map<string, number> {
  const out = new Map<string, number>();
  const { children, browsers } = scanProcesses(procRoot);

  if (clients) {
    for (const [session, client] of Object.entries(clients)) {
      const pid = browserPid(client);
      if (pid === null) continue;
      out.set(
        session,
        Math.round(processTreeMemoryKb(pid, procRoot, children) / 1024)
      );
    }
    return out;
  }

  // Fallback: attribute by profile dir (no client objects available).
  for (const [session, pid] of browsers)
    out.set(
      session,
      Math.round(processTreeMemoryKb(pid, procRoot, children) / 1024)
    );
  return out;
}

export function processTreeMemoryKb(
  rootPid: number,
  procRoot = '/proc',
  children = scanProcesses(procRoot).children
): number {
  let total = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += processMemoryKb(procRoot, pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

/**
 * Container memory use and limit from the cgroup, in bytes.
 *
 * @param {string} cgroupRoot Mount point of the cgroup fs; overridable for tests.
 * @param {string} selfCgroup This process's cgroup membership file.
 * @return {{usedBytes: number, limitBytes: number | null} | null} null when
 *   no cgroup memory controller is readable.
 */
export function containerMemory(
  cgroupRoot = '/sys/fs/cgroup',
  selfCgroup = '/proc/self/cgroup'
): { usedBytes: number; limitBytes: number | null } | null {
  // cgroup v2 keeps the files in the process's own cgroup directory: the
  // mount root inside a container ("0::/"), a sub-path anywhere else.
  const v2Path = /^0::(\/.*)$/m.exec(safeRead(selfCgroup) ?? '')?.[1];
  const layouts: Array<[string, string]> = [cgroupRoot]
    .concat(v2Path && v2Path !== '/' ? [path.join(cgroupRoot, v2Path)] : [])
    .map((dir) => [
      path.join(dir, 'memory.current'),
      path.join(dir, 'memory.max'),
    ]);
  // cgroup v1.
  layouts.push([
    path.join(cgroupRoot, 'memory/memory.usage_in_bytes'),
    path.join(cgroupRoot, 'memory/memory.limit_in_bytes'),
  ]);

  for (const [usedFile, limitFile] of layouts) {
    const used = readNumber(usedFile);
    if (used === null) continue;
    const limit = readNumber(limitFile);
    // v2 writes "max" and v1 a huge sentinel when there is no limit.
    const limitBytes = limit !== null && limit < 2 ** 60 ? limit : null;
    return { usedBytes: used, limitBytes };
  }
  return null;
}

/**
 * Build the one-line summary.
 *
 * @param {object} roots Filesystem roots and own pid; overridable for tests.
 * @return {string} The log line.
 */
export function resourceSummary({
  clients,
  procRoot = '/proc',
  cgroupRoot = '/sys/fs/cgroup',
  selfCgroup = '/proc/self/cgroup',
  selfPid = process.pid,
}: {
  clients?: Record<string, any>;
  procRoot?: string;
  cgroupRoot?: string;
  selfCgroup?: string;
  selfPid?: number;
} = {}): string {
  const perSession = [...perSessionMemoryMb(clients, procRoot).entries()]
    // Full session names: truncated names have been misread before.
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([session, mb]) => `${session} ${mb} MB`);

  const container = containerMemory(cgroupRoot, selfCgroup);
  const parts = [
    container
      ? `container ${gb(container.usedBytes)}${
          container.limitBytes ? ` / ${gb(container.limitBytes)}` : ''
        }`
      : 'container n/a',
    `node ${mb(processMemoryKb(procRoot, selfPid) * 1024)}`,
    `${perSession.length} browser(s)${
      perSession.length ? `: ${perSession.join(', ')}` : ''
    }`,
  ];
  return `[resources] ${parts.join(' · ')}`;
}

export function startResourceMonitor(
  logger: { info: (message: string) => unknown },
  clients?: Record<string, any>,
  intervalMs = RESOURCE_LOG_INTERVAL_MS
): NodeJS.Timeout | null {
  if (!(intervalMs > 0)) return null;
  const timer = setInterval(() => {
    try {
      logger.info(resourceSummary({ clients }));
    } catch {
      // Monitoring must never be the thing that breaks the server.
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

function browserProfile(procRoot: string, pid: number): string | null {
  const raw = safeRead(path.join(procRoot, String(pid), 'cmdline'));
  if (!raw) return null;
  const cmdline = raw.replace(/\0/g, ' ');
  if (/(?:^|\s)--type=/.test(cmdline)) return null;
  const dir = /(?:^|\s)--user-data-dir=(\S+)/.exec(cmdline)?.[1];
  return dir ? dir.replace(/[\\/]+$/, '') || null : null;
}

function parentPid(procRoot: string, pid: number): number | null {
  const stat = safeRead(path.join(procRoot, String(pid), 'stat'));
  if (!stat) return null;
  // The command name can contain spaces and parentheses; the fields after
  // the last ')' are fixed: state, then ppid.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

function processMemoryKb(procRoot: string, pid: number): number {
  const dir = path.join(procRoot, String(pid));
  const pss = matchKb(
    safeRead(path.join(dir, 'smaps_rollup')),
    /^Pss:\s+(\d+)/m
  );
  if (pss !== null) return pss;
  return matchKb(safeRead(path.join(dir, 'status')), /^VmRSS:\s+(\d+)/m) ?? 0;
}

function matchKb(text: string | null, pattern: RegExp): number | null {
  const match = text ? pattern.exec(text) : null;
  return match ? Number(match[1]) : null;
}

function readNumber(file: string): number | null {
  const text = safeRead(file)?.trim();
  if (!text || !/^\d+$/.test(text)) return null;
  return Number(text);
}

function safeRead(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
