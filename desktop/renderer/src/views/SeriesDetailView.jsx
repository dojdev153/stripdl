// desktop/renderer/src/views/SeriesDetailView.jsx
//
// Full port of the old openSeries()/buildChapterRows() pair. Read,
// Continue Reading, and chapter-row clicks open the real Reader via
// onOpenChapter/onContinue props.

import React, { useEffect, useState } from "react";
import { useToast } from "../context/ToastContext.jsx";
import { useConfirm } from "../context/ConfirmContext.jsx";
import { useDownloadTray } from "../context/DownloadTrayContext.jsx";
import { updateLastReadPosition } from "../lib/readingProgress.js";
import { invalidateLibraryCache } from "../lib/libraryCache.js";
import { toFileUrl } from "../lib/fileUrl.js";
import ScheduleCard from "../components/ScheduleCard.jsx";

export default function SeriesDetailView({
  series: initialSeries,
  onBack,
  onOpenChapter,
  onContinue,
}) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { openTray } = useDownloadTray();

  const [series, setSeries] = useState(initialSeries);
  const [chapterProgress, setChapterProgress] = useState({});

  useEffect(() => {
    setSeries(initialSeries);
  }, [initialSeries]);

  useEffect(() => {
    let cancelled = false;
    if (!series?.chapters?.length) return;
    Promise.all(
      series.chapters.map((ch) =>
        window.strip.progress
          .get(`${series.title}/${ch.number}`)
          .then((v) => v ?? 0)
          .catch(() => 0),
      ),
    ).then((results) => {
      if (cancelled) return;
      const map = {};
      series.chapters.forEach((ch, i) => {
        map[ch.number] = results[i];
      });
      setChapterProgress(map);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series?.directory]);

  if (!series) {
    return (
      <section id="view-series" className="view active">
        <button className="btn btn-ghost back-btn" onClick={onBack}>
          Library
        </button>
        <p className="muted">No series selected.</p>
      </section>
    );
  }

  const lastRead = series.lastRead;
  const lastReadCh = lastRead
    ? series.chapters?.find((ch) => ch.number == lastRead.chapterNumber)
    : null;
  const coverSrc = toFileUrl(series.coverPath);
  const tags = [series.genre, series.status].filter(Boolean);

  async function handleChapterContextMenu(e, chapter) {
    e.preventDefault();
    const action = await window.strip.menu.chapterContext({
      chapterDir: chapter.directory,
      chapterNumber: chapter.number,
    });

    if (action === "mark_read") {
      const lastPage = (chapter.pageCount || 1) - 1;
      await window.strip.progress.set(
        `${series.title}/${chapter.number}`,
        lastPage,
      );
      await updateLastReadPosition(
        series.title,
        chapter.number,
        lastPage,
        chapter.pageCount,
      );
      setChapterProgress((prev) => ({ ...prev, [chapter.number]: lastPage }));
      showToast(`Ch.${chapter.number} marked as read.`, "success");
    } else if (action === "delete") {
      const confirmed = await confirm(
        "Delete chapter",
        `Permanently delete Chapter ${chapter.number}? This cannot be undone.`,
      );
      if (!confirmed) return;

      const result = await window.strip.fs.deleteChapter(chapter.directory);
      if (result?.success) {
        setSeries((prev) => ({
          ...prev,
          chapters: prev.chapters.filter(
            (c) => c.directory !== chapter.directory,
          ),
        }));
        invalidateLibraryCache();
        showToast(`Chapter ${chapter.number} deleted.`, "success");
      } else {
        showToast(
          `Delete failed: ${result?.error || "Unknown error"}`,
          "error",
        );
      }
    }
  }

  return (
    <section id="view-series" className="view active">
      <button className="btn btn-ghost back-btn" onClick={onBack}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Library
      </button>

      <div className="series-detail-hero">
        {coverSrc ? (
          <img className="detail-cover" src={coverSrc} alt={series.title} />
        ) : (
          <div className="detail-cover-placeholder">◈</div>
        )}
        <div className="detail-info">
          <h1>{series.title}</h1>
          <div className="detail-author">
            {series.author || "Unknown author"}
          </div>
          {tags.length > 0 && (
            <div className="detail-tags">
              {tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="detail-desc">{series.description || ""}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              disabled={!series.chapters?.length}
              onClick={() => onOpenChapter(series.chapters[0], 0)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ width: 15, height: 15 }}
              >
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              {lastRead ? "Start Over" : "Read"}
            </button>
            {lastRead && (
              <button className="btn btn-secondary" onClick={onContinue}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ width: 15, height: 15 }}
                >
                  <circle cx="12" cy="12" r="10" />
                  <polygon points="10 8 16 12 10 16 10 8" />
                </svg>
                Continue Reading
                {lastReadCh && (
                  <span className="last-read-indicator">
                    Ch.{lastRead.chapterNumber}
                  </span>
                )}
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => openTray(series.url ?? series.metadata?.url ?? "")}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ width: 15, height: 15 }}
              >
                <path d="M12 3v13M7 11l5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
              Download more
            </button>
          </div>
        </div>
      </div>

      <ScheduleCard series={series} />

      <div className="chapter-list-header">
        <h2>
          Chapters{" "}
          <span
            className="muted"
            style={{ fontSize: 14, fontFamily: "var(--font-body)" }}
          >
            {series.chapters?.length ?? 0}
          </span>
        </h2>
      </div>
      <div className="chapter-list">
        {!series.chapters?.length && (
          <p className="muted" style={{ padding: 20 }}>
            No chapters downloaded.
          </p>
        )}
        {series.chapters?.map((ch) => {
          const hasProgress = (chapterProgress[ch.number] || 0) > 0;
          const isLastRead = lastRead && lastRead.chapterNumber == ch.number;
          return (
            <div
              key={ch.directory}
              className={`chapter-row ${hasProgress ? "has-progress" : ""} ${
                isLastRead ? "last-read" : ""
              }`}
              onClick={() => onOpenChapter(ch, 0)}
              onContextMenu={(e) => handleChapterContextMenu(e, ch)}
            >
              <span className="chapter-num">{ch.number}</span>
              <span className="chapter-title">{ch.title}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="chapter-date">{ch.date ?? ""}</span>
                <div className="chapter-progress-dot" title="In progress" />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
