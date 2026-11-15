// Hard anti-ban limits. Convex hands them to every run as its budget, and
// the host agent enforces them again on the phone.
export const RUN_BUDGET = { maxMs: 8 * 60_000, maxPosts: 60, maxStoryFrames: 40 };
export const SCHEDULED_RUNS_PER_DAY = 2;
export const SCHEDULE_LOCAL_HOURS = [9.5, 19.5];
export const SCHEDULE_JITTER_MS = 45 * 60_000;
export const TRIPWIRE_PAUSE_MS = 72 * 3_600_000;
export const STALE_CLAIM_MS = 15 * 60_000;
export const PAIRING_TTL_MS = 10 * 60_000;
export const STORY_TTL_MS = 24 * 3_600_000;
