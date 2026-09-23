import {
  forgetActivity,
  msSinceActivity,
  recordActivity,
} from '../sessionActivity';

/**
 * Idle time gates the recycler. A never-seen session must read as active (0),
 * not infinitely idle, so the recycler never closes a session it has no
 * history for.
 */
afterEach(() => {
  forgetActivity('s');
  forgetActivity('t');
});

describe('sessionActivity', () => {
  it('reports 0 idle for a session it has never seen, and remembers it', () => {
    expect(msSinceActivity('s', 1_000_000)).toBe(0);
    // now seeded at that time; 30s later it reads 30s idle
    expect(msSinceActivity('s', 1_030_000)).toBe(30_000);
  });

  it('resets idle to 0 when activity is recorded', () => {
    recordActivity('t', 1_000_000);
    expect(msSinceActivity('t', 1_090_000)).toBe(90_000);
    recordActivity('t', 1_100_000);
    expect(msSinceActivity('t', 1_100_000)).toBe(0);
  });

  it('never returns a negative idle if clocks go backwards', () => {
    recordActivity('t', 2_000_000);
    expect(msSinceActivity('t', 1_999_000)).toBe(0);
  });
});
