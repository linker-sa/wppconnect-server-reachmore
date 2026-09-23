import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  browserPid,
  containerMemory,
  perSessionMemoryMb,
  processTreeMemoryKb,
  resourceSummary,
  scanProcesses,
} from '../resourceMonitor';

/** A wppconnect client whose browser root process is `pid` (or none). */
const clientWithPid = (pid: number | null) => ({
  page: { browser: () => ({ process: () => (pid ? { pid } : null) }) },
});

/**
 * Sizing the shared container needs the per-session memory of real linked
 * accounts, which only the deployed server has. These pin the numbers the
 * [resources] log line reports, against a fake /proc and cgroup tree.
 */
let root: string;
let proc: string;
let cgroup: string;
let selfCgroup: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resmon-'));
  proc = path.join(root, 'proc');
  cgroup = path.join(root, 'cgroup');
  selfCgroup = path.join(root, 'self-cgroup');
  fs.mkdirSync(proc);
  fs.mkdirSync(cgroup);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeProcess(
  pid: number,
  ppid: number,
  memory: { pssKb?: number; rssKb?: number },
  { name = 'chrome', args = [] as string[] } = {}
) {
  const dir = path.join(proc, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'stat'),
    `${pid} (${name}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0`
  );
  fs.writeFileSync(path.join(dir, 'cmdline'), [name, ...args, ''].join('\0'));
  if (memory.pssKb !== undefined)
    fs.writeFileSync(
      path.join(dir, 'smaps_rollup'),
      `00400000-7fff [rollup]\nRss: ${memory.pssKb * 2} kB\nPss: ${
        memory.pssKb
      } kB\n`
    );
  if (memory.rssKb !== undefined)
    fs.writeFileSync(
      path.join(dir, 'status'),
      `Name:\tx\nVmRSS:\t${memory.rssKb} kB\n`
    );
}

const MB = 1024;

/** A session's Chromium: browser + renderer + gpu, as Chromium spawns them. */
function fakeChromium(rootPid: number, session: string, mbEach: number[]) {
  const profile = `--user-data-dir=/data/userDataDir/${session}`;
  fakeProcess(rootPid, 1, { pssKb: mbEach[0] * MB }, { args: [profile] });
  mbEach.slice(1).forEach((mb, i) =>
    fakeProcess(
      rootPid + i + 1,
      rootPid,
      { pssKb: mb * MB },
      // Children carry --type; some Chromium builds repeat the profile flag.
      { args: [`--type=${i ? 'gpu-process' : 'renderer'}`, profile] }
    )
  );
}

describe('processTreeMemoryKb', () => {
  it('sums PSS over the browser and every descendant, not other trees', () => {
    fakeProcess(100, 1, { pssKb: 1000 });
    fakeProcess(101, 100, { pssKb: 300 });
    fakeProcess(102, 100, { pssKb: 200 });
    fakeProcess(103, 101, { pssKb: 50 }); // grandchild
    fakeProcess(200, 1, { pssKb: 9999 }); // another session's browser
    fakeProcess(201, 200, { pssKb: 9999 });

    expect(processTreeMemoryKb(100, proc)).toBe(1550);
  });

  it('falls back to RSS when PSS is not readable', () => {
    fakeProcess(100, 1, { rssKb: 700 });
    fakeProcess(101, 100, { pssKb: 300 });
    expect(processTreeMemoryKb(100, proc)).toBe(1000);
  });

  it('parses a command name containing spaces and parentheses', () => {
    fakeProcess(100, 1, { pssKb: 10 }, { name: 'Chrome (Main) Thread' });
    fakeProcess(101, 100, { pssKb: 5 }, { name: 'a) b (c' });
    expect(processTreeMemoryKb(100, proc)).toBe(15);
  });

  it('returns 0 for a process that has already exited', () => {
    expect(processTreeMemoryKb(4242, proc)).toBe(0);
  });
});

describe('scanProcesses', () => {
  it('finds one browser per session by its profile dir, skipping children', () => {
    fakeChromium(100, 'wpp_reachmore_71_1789918239024', [300, 90, 20]);
    fakeChromium(200, 'wpp_reachmore_195_1789920296968', [280, 100, 20]);
    fakeProcess(300, 1, { pssKb: 10 }, { name: 'node', args: ['server.js'] });

    const { browsers } = scanProcesses(proc, '/data/userDataDir');
    expect([...browsers.entries()].sort()).toEqual([
      ['wpp_reachmore_195_1789920296968', 200],
      ['wpp_reachmore_71_1789918239024', 100],
    ]);
  });

  it("reads Chromium's rewritten, space-joined cmdline", () => {
    // What Chromium really leaves in /proc/<pid>/cmdline: one string, no NULs.
    const write = (pid: number, ppid: number, cmdline: string) => {
      fakeProcess(pid, ppid, { pssKb: 100 });
      fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), cmdline);
    };
    write(
      100,
      1,
      '/usr/lib/chromium/chromium --headless=new --no-sandbox --user-data-dir=/data/userDataDir/wpp_reachmore_71_1789918239024 --noerrdialogs'
    );
    write(
      101,
      100,
      '/usr/lib/chromium/chromium --type=zygote --no-sandbox --user-data-dir=/data/userDataDir/wpp_reachmore_71_1789918239024'
    );

    const { browsers } = scanProcesses(proc, '/data/userDataDir');
    expect([...browsers.entries()]).toEqual([
      ['wpp_reachmore_71_1789918239024', 100],
    ]);
  });

  it('accepts a profile path with a trailing slash', () => {
    fakeProcess(
      100,
      1,
      { pssKb: 1 },
      { args: ['--user-data-dir=./userDataDir/wpp_x/'] }
    );
    expect([...scanProcesses(proc, './userDataDir/').browsers.keys()]).toEqual([
      'wpp_x',
    ]);
  });
});

describe('containerMemory', () => {
  it('reads cgroup v2 usage and limit at the mount root (in a container)', () => {
    fs.writeFileSync(selfCgroup, '0::/\n');
    fs.writeFileSync(path.join(cgroup, 'memory.current'), '2147483648\n');
    fs.writeFileSync(path.join(cgroup, 'memory.max'), '8589934592\n');
    expect(containerMemory(cgroup, selfCgroup)).toEqual({
      usedBytes: 2147483648,
      limitBytes: 8589934592,
    });
  });

  it("follows the process's own cgroup path when not at the root", () => {
    fs.writeFileSync(selfCgroup, '0::/system.slice/app.scope\n');
    const own = path.join(cgroup, 'system.slice/app.scope');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'memory.current'), '1024\n');
    fs.writeFileSync(path.join(own, 'memory.max'), 'max\n');
    expect(containerMemory(cgroup, selfCgroup)).toEqual({
      usedBytes: 1024,
      limitBytes: null,
    });
  });

  it('falls back to cgroup v1 and ignores its "unlimited" sentinel', () => {
    fs.mkdirSync(path.join(cgroup, 'memory'));
    fs.writeFileSync(path.join(cgroup, 'memory/memory.usage_in_bytes'), '4096');
    fs.writeFileSync(
      path.join(cgroup, 'memory/memory.limit_in_bytes'),
      '9223372036854771712'
    );
    expect(containerMemory(cgroup, selfCgroup)).toEqual({
      usedBytes: 4096,
      limitBytes: null,
    });
  });

  it('returns null when no memory controller is readable', () => {
    expect(containerMemory(cgroup, selfCgroup)).toBeNull();
  });
});

describe('perSessionMemoryMb', () => {
  it('sums each session tree from its client browser pid', () => {
    fakeChromium(100, 'wpp_a', [300, 90, 22]);
    fakeChromium(200, 'wpp_b', [280, 98, 20]);
    const mem = perSessionMemoryMb(
      { wpp_a: clientWithPid(100), wpp_b: clientWithPid(200) },
      proc
    );
    expect(mem.get('wpp_a')).toBe(412);
    expect(mem.get('wpp_b')).toBe(398);
  });

  it('skips a session whose browser is not running', () => {
    fakeChromium(100, 'wpp_a', [300, 90, 22]);
    const mem = perSessionMemoryMb(
      {
        wpp_a: clientWithPid(100),
        wpp_starting: clientWithPid(null),
        gone: {},
      },
      proc
    );
    expect([...mem.keys()]).toEqual(['wpp_a']);
  });
});

describe('browserPid', () => {
  it('reads the pid, and returns null when the handle throws or is empty', () => {
    expect(browserPid(clientWithPid(4242))).toBe(4242);
    expect(browserPid(clientWithPid(null))).toBeNull();
    expect(browserPid({})).toBeNull();
    expect(
      browserPid({
        page: {
          browser: () => {
            throw new Error('closed');
          },
        },
      })
    ).toBeNull();
  });
});

describe('resourceSummary', () => {
  it('reports container, node and every browser by full session name', () => {
    fakeChromium(100, 'wpp_reachmore_71_1789918239024', [300, 90, 22]);
    fakeChromium(200, 'wpp_reachmore_195_1789920296968', [280, 98, 20]);
    fakeProcess(300, 1, { pssKb: 171 * MB }, { name: 'node' });
    fs.writeFileSync(selfCgroup, '0::/\n');
    fs.writeFileSync(
      path.join(cgroup, 'memory.current'),
      String(2 * 1024 ** 3)
    );
    fs.writeFileSync(path.join(cgroup, 'memory.max'), String(8 * 1024 ** 3));

    const line = resourceSummary({
      clients: {
        wpp_reachmore_71_1789918239024: clientWithPid(100),
        wpp_reachmore_195_1789920296968: clientWithPid(200),
      },
      procRoot: proc,
      cgroupRoot: cgroup,
      selfCgroup,
      selfPid: 300,
    });

    expect(line).toBe(
      '[resources] container 2.00 GB / 8.00 GB · node 171 MB · 2 browser(s): ' +
        'wpp_reachmore_195_1789920296968 398 MB, wpp_reachmore_71_1789918239024 412 MB'
    );
  });

  it('degrades to n/a and zero browsers instead of throwing', () => {
    const line = resourceSummary({
      procRoot: path.join(root, 'missing'),
      cgroupRoot: cgroup,
      selfCgroup,
      selfPid: 1,
    });
    expect(line).toBe('[resources] container n/a · node 0 MB · 0 browser(s)');
  });
});
