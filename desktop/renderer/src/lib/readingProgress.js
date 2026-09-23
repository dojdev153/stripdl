// desktop/renderer/src/lib/readingProgress.js
//
// Reading-progress helpers shared across the library and (eventually)
// reader views. Two changes from the old app.js version worth noting:
//
//   1. getSeriesProgress() is now a pure function, computeSeriesProgress(),
//      that takes an already-fetched `lastRead` object instead of doing its
//      own IPC call. The old code called getLastReadPosition() once inside
//      getSeriesProgress() AND once again in buildSeriesCard() for the
//      same series — two IPC round trips for data that only changes when
//      the user actually reads something. useLibrary.js now fetches
//      lastRead once per series and derives both the "Continue" badge
//      visibility and the progress percentage from that single value.
//
//   2. getRecentlyReadTs() is new — factors out the
//      `${title}/recentlyRead` lookup that was previously inlined in
//      app.js's renderLibrary().

export async function getLastReadPosition(seriesTitle) {
  try {
    return await window.strip.progress.get(`${seriesTitle}/lastRead`);
  } catch (_) {
    return null;
  }
}

export async function getRecentlyReadTs(seriesTitle) {
  try {
    return await window.strip.progress.get(`${seriesTitle}/recentlyRead`);
  } catch (_) {
    return 0;
  }
}

export async function updateLastReadPosition(
  seriesTitle,
  chapterNumber,
  pageIndex,
  totalPages,
) {
  try {
    await window.strip.progress.set(`${seriesTitle}/lastRead`, {
      chapterNumber,
      pageIndex,
      totalPages,
      timestamp: Date.now(),
    });
    await window.strip.progress.set(`${seriesTitle}/recentlyRead`, Date.now());
  } catch (e) {
    console.error("Failed to update reading position:", e);
  }
}

/** Pure — no IPC. Takes an already-fetched lastRead object (or null). */
export function computeSeriesProgress(series, lastRead) {
  if (!series?.chapters?.length || !lastRead) return 0;
  const idx = series.chapters.findIndex(
    (c) => c.number == lastRead.chapterNumber,
  );
  if (idx === -1) return 0;
  const chProg = lastRead.pageIndex / (lastRead.totalPages || 1);
  return ((idx + chProg) / series.chapters.length) * 100;
}
