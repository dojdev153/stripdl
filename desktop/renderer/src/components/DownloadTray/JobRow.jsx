// desktop/renderer/src/components/DownloadTray/JobRow.jsx
//
// Port of the old _createJobEl()/_updateChapterRow() pair. The expand
// toggle only renders once the job has at least one chapter row — a
// small, harmless simplification versus the original, which always
// rendered the toggle button even when there was nothing yet to expand.

import React, { useEffect, useRef, useState } from "react";

function chapterPct(ch) {
  return ch.total > 0 ? Math.round((ch.done / ch.total) * 100) : 0;
}

export default function JobRow({ job, onCancel, onDismiss }) {
  const [expanded, setExpanded] = useState(false);
  const autoExpandedRef = useRef(false);

  // Auto-expand the first time chapter rows appear, same as the old
  // _ensureChapterRow()'s `listEl.style.display = "block"` — but only
  // once, so a user who manually collapses it isn't forced back open by
  // the next chapter starting.
  useEffect(() => {
    if (!autoExpandedRef.current && job.chapterOrder.length > 0) {
      autoExpandedRef.current = true;
      setExpanded(true);
    }
  }, [job.chapterOrder.length]);

  const displayTitle =
    job.title || (job.url.length > 55 ? job.url.slice(0, 52) + "…" : job.url);
  const finished = ["done", "error", "cancelled"].includes(job.status);
  const overallPct =
    job.status === "done"
      ? 100
      : job.totalChapters > 0
        ? Math.round((job.chaptersCompleted / job.totalChapters) * 100)
        : 0;

  return (
    <div className="tray-job">
      <div className="tray-job-header">
        <div className="tray-job-title-row">
          <span className="tray-job-title">{displayTitle}</span>
          <div className="tray-job-actions">
            <span className={`tray-job-status-badge status-${job.status}`}>
              {job.status}
            </span>
            {job.chapterOrder.length > 0 && (
              <button
                className="btn btn-ghost icon-btn tray-job-expand-btn"
                title="Toggle chapters"
                onClick={() => setExpanded((v) => !v)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ width: 11, height: 11 }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
            <button
              className="btn btn-ghost icon-btn"
              title={finished ? "Dismiss" : "Cancel"}
              onClick={() =>
                finished ? onDismiss(job.downloadId) : onCancel(job.downloadId)
              }
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ width: 12, height: 12 }}
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div className="tray-job-bar-wrap">
          <div className="tray-job-bar">
            <div
              className="tray-job-fill"
              style={{ width: `${overallPct}%` }}
            />
          </div>
          <span className="tray-job-pct">{overallPct}%</span>
        </div>
      </div>

      {expanded && job.chapterOrder.length > 0 && (
        <div className="tray-chapters-list">
          {job.chapterOrder.map((id) => {
            const ch = job.chapters[id];
            const pct = chapterPct(ch);
            return (
              <div className="tray-ch-row" key={id}>
                <span className="tray-ch-label">
                  {ch.title ? `Ch.${id} – ${ch.title}` : `Ch.${id}`}
                </span>
                <div className="tray-ch-bar">
                  <div className="tray-ch-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="tray-ch-pct">{pct}%</span>
                <span className="tray-ch-status">{ch.statusText}</span>
              </div>
            );
          })}
        </div>
      )}

      {job.log.length > 0 && (
        <div className="tray-job-log">
          {job.log.map((line, i) => (
            <div
              key={i}
              style={
                line.type === "error" ? { color: "var(--danger)" } : undefined
              }
            >
              {line.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
