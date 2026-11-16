// Local dates and times for the brief. Everything else stores epoch ms; only
// the brief's date (YYYY-MM-DD) and the dispatch check are in the user's zone.

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(timeZone: string | undefined) {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

export function localTime(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// The brief starts at 6:30 local so it's ready by 7:00. The cron runs hourly
// at :30 UTC, so exactly one tick lands in [6:30, 7:30) local for every zone,
// including half-hour and 45-minute offsets, and across DST changes.
export const DISPATCH_START_MINUTES = 6 * 60 + 30;

export function isDispatchTime(at: number, timeZone: string) {
  const { minutes } = localTime(at, timeZone);
  return minutes >= DISPATCH_START_MINUTES && minutes < DISPATCH_START_MINUTES + 60;
}
