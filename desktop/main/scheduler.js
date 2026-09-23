// desktop/main/scheduler.js
//
// Per-series release-day auto-download scheduler.
//
// Concept: each series can be subscribed to specific weekdays (e.g. "every
// Thursday"). On each scheduler tick, any subscribed series whose scheduled
// day matches today AND hasn't already run today gets checked for new
// chapters — but only if the machine currently has an internet connection.
// If there's no connection, the check is simply retried on the next tick
// (nothing is marked "done" for the day), so a series scheduled for
// Thursday but checked while offline will still catch up once connectivity
// returns, as long as it's still Thursday (local time) when that happens.
//
// This module is UI-agnostic: it exposes startScheduler(), which the main
// process wires up to actually spawn stripdl and emit progress/notification
// events. Nothing here touches Electron APIs directly, so it's easy to
// reason about (and test) independently of the app shell.

const dns = require("dns");

const DAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// How often to check "is today a scheduled day and have we run yet."
// Deliberately short (well under a day) so a series checked while offline
// gets retried promptly once the network comes back, without hammering
// anything — the check itself is a cheap DNS lookup unless a download
// actually needs to start.
const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Return today's 3-letter weekday code ("thu") and YYYY-MM-DD date string,
 * both in local time (so "every Thursday" means the user's Thursday, not
 * UTC's).
 */
function todayInfo() {
  const now = new Date();
  const dayCode = DAY_CODES[now.getDay()];
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return { dayCode, dateStr: `${y}-${m}-${d}` };
}

/**
 * Lightweight connectivity probe. Resolves true/false; never throws.
 * Uses a plain DNS lookup (no HTTP request) against a couple of
 * well-known, high-availability hostnames so a single provider outage
 * doesn't produce a false "offline" reading.
 */
function isOnline(timeoutMs = 5000) {
  const hosts = ["dns.google", "one.one.one.one"];

  const probe = (host) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      dns.lookup(host, (err) => {
        clearTimeout(timer);
        resolve(!err);
      });
    });

  return Promise.all(hosts.map(probe)).then((results) => results.some(Boolean));
}

/**
 * Start the scheduler loop.
 *
 * @param {Object} opts
 * @param {() => Record<string, ScheduleEntry>} opts.getSchedules
 *        Returns the current { [seriesKey]: ScheduleEntry } map.
 *        ScheduleEntry: { url, title, enabled, days: string[], lastRun }
 * @param {(seriesKey: string, patch: Partial<ScheduleEntry>) => void} opts.updateSchedule
 *        Persists a partial update to one schedule entry.
 * @param {(seriesKey: string, entry: ScheduleEntry) => Promise<{downloaded:number, error?:string}>} opts.runCheck
 *        Actually performs the download check for one series. Must resolve
 *        (not throw) even on failure — return { downloaded: 0, error: "..." }.
 * @returns {{ stop: () => void, runNow: () => Promise<void> }}
 */
function startScheduler({ getSchedules, updateSchedule, runCheck }) {
  let stopped = false;
  let running = false; // re-entrancy guard — one tick at a time

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const { dayCode, dateStr } = todayInfo();
      const schedules = getSchedules() || {};

      const due = Object.entries(schedules).filter(([, entry]) => {
        if (!entry || entry.enabled === false) return false;
        if (!Array.isArray(entry.days) || !entry.days.includes(dayCode))
          return false;
        return entry.lastRun !== dateStr;
      });

      if (due.length === 0) return;

      // Only pay the DNS-probe cost when there's actually something to run.
      const online = await isOnline();
      if (!online) return; // retried on the next tick

      for (const [seriesKey, entry] of due) {
        if (stopped) break;
        try {
          const result = await runCheck(seriesKey, entry);
          updateSchedule(seriesKey, {
            lastRun: dateStr,
            lastResult: result.error ? "error" : "checked",
            lastDownloadedCount: result.downloaded || 0,
            lastError: result.error || null,
            lastCheckedAt: Date.now(),
          });
        } catch (e) {
          // runCheck is expected to catch its own errors, but guard anyway
          // so one bad series can't stop the rest of the batch or crash
          // the scheduler loop.
          updateSchedule(seriesKey, {
            lastRun: dateStr,
            lastResult: "error",
            lastError: e && e.message ? e.message : String(e),
            lastCheckedAt: Date.now(),
          });
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, TICK_INTERVAL_MS);
  // Also run shortly after startup (staggered so it doesn't compete with
  // initial window paint / library scan), and don't block app launch on it.
  const startupTimer = setTimeout(tick, 20 * 1000);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(startupTimer);
    },
    runNow: tick,
  };
}

module.exports = { startScheduler, isOnline, todayInfo, DAY_CODES };
