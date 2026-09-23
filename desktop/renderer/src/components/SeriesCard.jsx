// desktop/renderer/src/components/SeriesCard.jsx
//
// Adds a visible delete button and bulk-select support alongside the
// existing right-click delete. selectMode/selected/onToggleSelect are
// optional — omitting them keeps the card behaving exactly as before.

import React from "react";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import { toFileUrl } from "../lib/fileUrl.js";

export default function SeriesCard({
  series,
  onOpen,
  onContinue,
  onDeleted,
  selectMode = false,
  selected = false,
  onToggleSelect,
}) {
  const { showToast } = useToast();
  const confirm = useConfirm();

  const coverSrc = toFileUrl(series.coverPath);

  // Badge for latest chapter read (if available)
  const latestReadChapter = series.lastRead?.chapterNumber;

  async function deleteSeries() {
    const confirmed = await confirm(
      "Delete series",
      `Permanently delete "${series.title}" from disk? This cannot be undone.`,
    );
    if (!confirmed) return;

    const result = await window.strip.fs.deleteSeries(series.directory);
    if (result?.success) {
      onDeleted(series.directory);
      showToast(`"${series.title}" deleted.`, "success");
    } else {
      showToast(`Delete failed: ${result?.error || "Unknown error"}`, "error");
    }
  }

  async function handleContextMenu(e) {
    e.preventDefault();
    if (selectMode) return;
    const action = await window.strip.menu.seriesContext({
      seriesDir: series.directory,
      seriesTitle: series.title,
    });
    if (action === "delete") deleteSeries();
  }

  function handleCardClick() {
    if (selectMode) onToggleSelect?.(series.directory);
    else onOpen(series);
  }

  return (
    <div
      className={`series-card ${selectMode ? "select-mode" : ""} ${
        selected ? "is-selected" : ""
      }`}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
    >
      <div className="series-cover-wrap">
        {selectMode && (
          <label
            className="series-card-checkbox"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect?.(series.directory)}
            />
          </label>
        )}

        {!selectMode && (
          <button
            className="series-card-delete-btn"
            title="Delete series"
            onClick={(e) => {
              e.stopPropagation();
              deleteSeries();
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </button>
        )}

        {coverSrc ? (
          <img
            className="series-cover"
            src={coverSrc}
            alt={series.title}
            loading="lazy"
          />
        ) : (
          <div className="series-cover-placeholder">◈</div>
        )}

        {/* Chapter count badge */}
        <span className="series-card-badge">
          {series.chapters?.length ?? 0} ch
        </span>

        {/* Latest read chapter badge */}
        {latestReadChapter != null && (
          <div className="series-card-latest-badge">
            Latest: Ch.{latestReadChapter}
          </div>
        )}

        {/* Continue reading button */}
        {!selectMode && series.lastRead && (
          <div
            className="series-card-continue-badge"
            onClick={(e) => {
              e.stopPropagation();
              if (onContinue) onContinue(series);
              else onOpen(series);
            }}
          >
            Continue
          </div>
        )}

        {series.progress > 0 && (
          <div className="series-card-progress">
            <div
              className="series-card-progress-fill"
              style={{ width: `${series.progress}%` }}
            />
          </div>
        )}
      </div>
      <div className="series-card-title">{series.title}</div>
      <div className="series-card-meta">{series.author || ""}</div>
    </div>
  );
}
