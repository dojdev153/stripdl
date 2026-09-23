// desktop/renderer/src/context/DownloadTrayContext.jsx
//
// Global download-job state and the tray's open/collapsed UI state, both
// live here so the Sidebar's badge count, Library's "Add Comic" button,
// and SeriesDetailView's "Download more" button can all reach the same
// state without prop-drilling through App.jsx.
//
// PERFORMANCE NOTE — read this before changing the progress pipeline:
// Raw "progress" events (one per page saved) can arrive very frequently
// during active downloads, especially with multiple concurrent jobs at
// default concurrency settings. An earlier version of this file
// dispatched a state update synchronously on every single raw IPC event,
// which fanned out into a full re-render of every context consumer
// (Sidebar, Library's series grid, Series detail, the tray itself) on
// every tick — frequently enough to visibly freeze the renderer ("Not
// Responding") during a busy download. The pre-React vanilla-JS tray
// avoided this by batching rapid DOM updates through
// requestAnimationFrame; that batching did not carry over when this was
// ported to React, and this is the fix that restores it.
//
// Two changes from a naive per-event dispatch:
//   1. Incoming events are buffered in pendingRef and flushed as ONE
//      "BATCH" action per animation frame, capping render frequency at
//      ~60/sec regardless of raw event volume. applyProgress() is still
//      applied to every buffered event in order within the batch, so no
//      progress data is lost or coalesced incorrectly — only the render
//      frequency is capped, not the data fidelity.
//   2. job.log and the per-chapter tracking map (chapters/chapterOrder)
//      are both capped (see MAX_LOG_LINES / MAX_TRACKED_CHAPTERS) so a
//      very large series (hundreds of chapters) doesn't grow render cost
//      unboundedly over the life of a long download. Oldest entries are
//      dropped first — these are almost always already-completed
//      chapters, so nothing currently useful is lost from view.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { useConfig } from "../hooks/useConfig.js";
import { useToast } from "./ToastContext.jsx";

const DownloadTrayContext = createContext(null);

const MAX_LOG_LINES = 200;
const MAX_TRACKED_CHAPTERS = 60;

const initialState = {
  isOpen: false,
  isCollapsed: false,
  prefillUrl: "",
  prefillToken: 0,
  jobs: {}, // downloadId -> job
  queue: {}, // queueId -> { url, chapters }
  itemOrder: [], // [{ type: 'job'|'queued', id }], newest-first
};

function newJob(downloadId, url) {
  return {
    downloadId,
    url,
    title: null,
    active: true,
    status: "starting",
    totalChapters: 0,
    chaptersCompleted: 0,
    chapters: {}, // chapterId -> { title, done, total, statusText }
    chapterOrder: [],
    log: [], // { msg, type }
  };
}

/** Bounded log append — keeps at most MAX_LOG_LINES, dropping the oldest. */
function appendLog(log, entry) {
  const next = [...log, entry];
  return next.length > MAX_LOG_LINES
    ? next.slice(next.length - MAX_LOG_LINES)
    : next;
}

/**
 * Create/touch a chapter entry, then enforce MAX_TRACKED_CHAPTERS by
 * dropping the oldest tracked chapters (almost always already-completed
 * ones, since chapters are appended in roughly the order they start).
 */
function touchChapter(chapters, chapterOrder, id, title) {
  let nextChapters = chapters;
  let nextOrder = chapterOrder;

  if (!chapters[id]) {
    nextChapters = {
      ...chapters,
      [id]: { title: title || null, done: 0, total: 0, statusText: "" },
    };
    nextOrder = [...chapterOrder, id];
  }

  if (nextOrder.length > MAX_TRACKED_CHAPTERS) {
    const overflow = nextOrder.length - MAX_TRACKED_CHAPTERS;
    const dropped = nextOrder.slice(0, overflow);
    nextOrder = nextOrder.slice(overflow);
    if (nextChapters === chapters) nextChapters = { ...chapters };
    dropped.forEach((did) => delete nextChapters[did]);
  }

  return { chapters: nextChapters, chapterOrder: nextOrder };
}

function applyProgress(job, data) {
  switch (data.status) {
    case "series_info":
      return {
        ...job,
        title: data.title || job.title,
        status: "active",
        active: true,
      };

    case "fetching_chapters":
      return job;

    case "chapter_list":
      return { ...job, totalChapters: data.total, chaptersCompleted: 0 };

    case "downloading":
      return {
        ...job,
        totalChapters:
          (data.chapters_to_download || 0) + (data.chapters_skipped || 0),
        chaptersCompleted: data.chapters_skipped || 0,
      };

    case "chapter_start": {
      const chId = data.chapter_id ?? data.chapter;
      const { chapters, chapterOrder } = touchChapter(
        job.chapters,
        job.chapterOrder,
        chId,
        data.title,
      );
      return { ...job, chapters, chapterOrder, status: "active", active: true };
    }

    case "progress": {
      const chId = data.chapter_id ?? data.chapter;
      const { chapters, chapterOrder } = touchChapter(
        job.chapters,
        job.chapterOrder,
        chId,
        null,
      );
      if (!chapters[chId]) return { ...job, chapterOrder }; // dropped by the cap, nothing to update
      return {
        ...job,
        chapterOrder,
        chapters: {
          ...chapters,
          [chId]: {
            ...chapters[chId],
            done: data.page,
            total: data.total_pages,
            statusText: "",
          },
        },
      };
    }

    case "chapter_done": {
      const chId = data.chapter_id ?? data.chapter;
      const chapters = job.chapters[chId]
        ? {
            ...job.chapters,
            [chId]: {
              ...job.chapters[chId],
              done: data.pages_saved,
              total: data.pages_saved,
              statusText: "✓",
            },
          }
        : job.chapters;
      return {
        ...job,
        chapters,
        chaptersCompleted: (job.chaptersCompleted || 0) + 1,
        log: appendLog(job.log, {
          msg: `✓ Ch.${chId} (${data.pages_saved} pages)`,
          type: "info",
        }),
      };
    }

    case "skipped": {
      const chId = data.chapter_id ?? data.chapter;
      return {
        ...job,
        chaptersCompleted: (job.chaptersCompleted || 0) + 1,
        log: appendLog(job.log, { msg: `– Ch.${chId} skipped`, type: "info" }),
      };
    }

    case "rate_limited": {
      const chId = data.chapter_id ?? data.chapter;
      if (!chId || !job.chapters[chId]) return job;
      return {
        ...job,
        chapters: {
          ...job.chapters,
          [chId]: {
            ...job.chapters[chId],
            statusText: `⏳ ${data.wait_seconds}s`,
          },
        },
      };
    }

    case "done":
      return {
        ...job,
        title: data.series || job.title,
        status: "done",
        active: false,
        log: appendLog(job.log, {
          msg: `✓ Saved to ${data.directory}`,
          type: "info",
        }),
      };

    case "error": {
      const chId = data.chapter_id ?? data.chapter;
      if (chId) {
        if (!job.chapters[chId]) return job;
        return {
          ...job,
          chapters: {
            ...job.chapters,
            [chId]: { ...job.chapters[chId], statusText: "✗" },
          },
          log: appendLog(job.log, { msg: `✗ ${data.message}`, type: "error" }),
        };
      }
      return {
        ...job,
        status: "error",
        active: false,
        log: appendLog(job.log, { msg: `✗ ${data.message}`, type: "error" }),
      };
    }

    case "process_exit":
      if (data.code === 0 || !job.active) return job;
      return {
        ...job,
        status: "error",
        active: false,
        log: appendLog(job.log, {
          msg: `Process exited (code ${data.code})`,
          type: "error",
        }),
      };

    case "log":
      return {
        ...job,
        log: appendLog(job.log, { msg: data.message, type: "info" }),
      };

    default:
      return job;
  }
}

function reducer(state, action) {
  switch (action.type) {
    case "OPEN":
      return {
        ...state,
        isOpen: true,
        isCollapsed: false,
        prefillUrl: action.url || "",
        prefillToken: state.prefillToken + 1,
      };
    case "CLOSE":
      return { ...state, isOpen: false, isCollapsed: false };
    case "COLLAPSE":
      return { ...state, isCollapsed: true };
    case "EXPAND":
      return { ...state, isCollapsed: false };
    case "TOGGLE_COLLAPSE":
      return { ...state, isCollapsed: !state.isCollapsed };

    case "START_JOB":
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [action.downloadId]: newJob(action.downloadId, action.url),
        },
        itemOrder: [{ type: "job", id: action.downloadId }, ...state.itemOrder],
      };

    case "DISMISS_JOB": {
      const jobs = { ...state.jobs };
      delete jobs[action.downloadId];
      return {
        ...state,
        jobs,
        itemOrder: state.itemOrder.filter(
          (i) => !(i.type === "job" && i.id === action.downloadId),
        ),
      };
    }

    case "SET_STATUS": {
      const job = state.jobs[action.downloadId];
      if (!job) return state;
      return {
        ...state,
        jobs: {
          ...state.jobs,
          [action.downloadId]: { ...job, status: action.status, active: false },
        },
      };
    }

    // Applies a batch of buffered progress events in one state update —
    // see the file header comment for why this replaced per-event
    // dispatch. Events are still applied in arrival order within the
    // batch, so cumulative fields (chaptersCompleted, log) stay correct.
    case "BATCH": {
      let jobs = state.jobs;
      let changed = false;
      for (const { downloadId, data } of action.items) {
        const job = jobs[downloadId];
        if (!job) continue;
        const updated = applyProgress(job, data);
        if (updated !== job) {
          if (!changed) {
            jobs = { ...jobs };
            changed = true;
          }
          jobs[downloadId] = updated;
        }
      }
      return changed ? { ...state, jobs } : state;
    }

    case "ENQUEUE":
      return {
        ...state,
        queue: {
          ...state.queue,
          [action.entry.queueId]: {
            url: action.entry.url,
            chapters: action.entry.chapters,
          },
        },
        itemOrder: [
          { type: "queued", id: action.entry.queueId },
          ...state.itemOrder,
        ],
      };

    case "PROMOTE_QUEUED": {
      const queue = { ...state.queue };
      delete queue[action.queueId];
      return {
        ...state,
        queue,
        itemOrder: state.itemOrder.map((item) =>
          item.type === "queued" && item.id === action.queueId
            ? { type: "job", id: action.downloadId }
            : item,
        ),
        jobs: {
          ...state.jobs,
          [action.downloadId]: newJob(action.downloadId, action.url),
        },
      };
    }

    case "DEQUEUE_ONLY": {
      const queue = { ...state.queue };
      delete queue[action.queueId];
      return {
        ...state,
        queue,
        itemOrder: state.itemOrder.filter(
          (i) => !(i.type === "queued" && i.id === action.queueId),
        ),
      };
    }

    default:
      return state;
  }
}

export function DownloadTrayProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { config } = useConfig();
  const { showToast } = useToast();

  // Buffer raw IPC events and flush them as ONE dispatch per animation
  // frame — see the file header comment for why this exists.
  const pendingRef = useRef([]);
  const rafRef = useRef(null);

  useEffect(() => {
    function flush() {
      rafRef.current = null;
      if (pendingRef.current.length === 0) return;
      const items = pendingRef.current;
      pendingRef.current = [];
      dispatch({ type: "BATCH", items });
    }

    function onProgress(data) {
      if (!data?.downloadId) return;
      pendingRef.current.push({ downloadId: data.downloadId, data });
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    }

    window.strip.download.onProgress(onProgress);
    return () => {
      window.strip.download.offProgress(onProgress);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const doStartJob = useCallback(
    async (url, chapters) => {
      try {
        return await window.strip.download.start({
          url,
          chapters: chapters || undefined,
          downloadDir: config?.downloadDir,
        });
      } catch (e) {
        showToast(`Failed to start download: ${e.message}`, "error");
        return null;
      }
    },
    [config, showToast],
  );

  const startJob = useCallback(
    async (url, chapters) => {
      const activeCount = Object.values(state.jobs).filter(
        (j) => j.active,
      ).length;
      const maxJobs = config?.maxConcurrentJobs ?? 2;

      if (activeCount < maxJobs) {
        const downloadId = await doStartJob(url, chapters);
        if (!downloadId) return false;
        dispatch({ type: "START_JOB", downloadId, url });
        return true;
      }

      dispatch({
        type: "ENQUEUE",
        entry: {
          queueId: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          url,
          chapters,
        },
      });
      showToast("Download queued — will start when a slot is free.", "info");
      return false;
    },
    [state.jobs, config, doStartJob, showToast],
  );

  useEffect(() => {
    const activeCount = Object.values(state.jobs).filter(
      (j) => j.active,
    ).length;
    const maxJobs = config?.maxConcurrentJobs ?? 2;
    const queueIds = Object.keys(state.queue);
    if (queueIds.length === 0 || activeCount >= maxJobs) return;

    const queueId = queueIds[0];
    const { url, chapters } = state.queue[queueId];
    let cancelled = false;

    (async () => {
      const downloadId = await doStartJob(url, chapters);
      if (cancelled) return;
      if (!downloadId) {
        dispatch({ type: "DEQUEUE_ONLY", queueId });
        return;
      }
      dispatch({ type: "PROMOTE_QUEUED", queueId, downloadId, url });
    })();

    return () => {
      cancelled = true;
    };
  }, [state.jobs, state.queue, config, doStartJob]);

  const cancelJob = useCallback(async (downloadId) => {
    await window.strip.download.cancel(downloadId);
    dispatch({ type: "SET_STATUS", downloadId, status: "cancelled" });
  }, []);

  const dismissJob = useCallback((downloadId) => {
    dispatch({ type: "DISMISS_JOB", downloadId });
  }, []);

  const openTray = useCallback((url = "") => {
    dispatch({ type: "OPEN", url });
  }, []);

  const closeTray = useCallback(() => {
    const activeCount = Object.values(state.jobs).filter(
      (j) => j.active,
    ).length;
    dispatch({ type: activeCount > 0 ? "COLLAPSE" : "CLOSE" });
  }, [state.jobs]);

  const toggleCollapse = useCallback(() => {
    dispatch({ type: "TOGGLE_COLLAPSE" });
  }, []);

  const handleNavClick = useCallback(() => {
    if (!state.isOpen) dispatch({ type: "OPEN", url: "" });
    else if (state.isCollapsed) dispatch({ type: "EXPAND" });
    else dispatch({ type: "COLLAPSE" });
  }, [state.isOpen, state.isCollapsed]);

  const activeJobCount = useMemo(
    () => Object.values(state.jobs).filter((j) => j.active).length,
    [state.jobs],
  );

  const jobCountLabel = useMemo(() => {
    if (activeJobCount > 0) return `(${activeJobCount} active)`;
    const total = Object.keys(state.jobs).length;
    return total > 0 ? `(${total} done)` : "";
  }, [activeJobCount, state.jobs]);

  const value = {
    isOpen: state.isOpen,
    isCollapsed: state.isCollapsed,
    prefillUrl: state.prefillUrl,
    prefillToken: state.prefillToken,
    jobs: state.jobs,
    queue: state.queue,
    itemOrder: state.itemOrder,
    activeJobCount,
    jobCountLabel,
    openTray,
    closeTray,
    toggleCollapse,
    handleNavClick,
    startJob,
    cancelJob,
    dismissJob,
  };

  return (
    <DownloadTrayContext.Provider value={value}>
      {children}
    </DownloadTrayContext.Provider>
  );
}

export function useDownloadTray() {
  const ctx = useContext(DownloadTrayContext);
  if (!ctx)
    throw new Error(
      "useDownloadTray must be used within <DownloadTrayProvider>",
    );
  return ctx;
}
