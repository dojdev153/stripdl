// desktop/renderer/src/views/ReaderView.jsx
//
// Full port of the old vanilla-JS reader: per-page IntersectionObserver
// lazy loading, scroll-position tracking with debounced progress saves,
// next-chapter preload, resume-to-saved-page on open, and keyboard
// shortcuts.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useConfig } from "../hooks/useConfig.js";
import { updateLastReadPosition } from "../lib/readingProgress.js";
import { createProgressDebouncer } from "../lib/progressDebouncer.mjs";
import {
  getVisiblePageIndex,
  getReaderWindow,
  getWindowSpacerHeights,
} from "../lib/readerWindow.mjs";
import { toFileUrl } from "../lib/fileUrl.js";

function PageImage({ src, index, eager, loaded, wrapperRef }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const shouldRender = eager || loaded;

  return (
    <div
      ref={wrapperRef}
      data-page-index={index}
      style={{ width: "100%", position: "relative", minHeight: 200 }}
    >
      {!imgLoaded && !imgError && <div className="reader-page-loading" />}
      {shouldRender && (
        <img
          className="reader-page-img"
          style={{ display: imgLoaded ? "block" : "none" }}
          alt={`Page ${index + 1}`}
          src={src}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgError(true)}
        />
      )}
      {imgError && (
        <div className="reader-page-error">
          Page {index + 1} could not be loaded.
        </div>
      )}
    </div>
  );
}

export default function ReaderView({
  series,
  chapter,
  scrollToPage = 0,
  onBack,
  onExitToLibrary,
  onNavigateChapter,
}) {
  const { config } = useConfig();
  const [pages, setPages] = useState([]);
  const [error, setError] = useState(null);
  const [visibleIndex, setVisibleIndex] = useState(0);
  const [showEndOverlay, setShowEndOverlay] = useState(false);
  const [loadedSet, setLoadedSet] = useState(() => new Set());
  const [startPage, setStartPage] = useState(0);
  const [pageHeights, setPageHeights] = useState([]);

  const containerRef = useRef(null);
  const pageRefs = useRef([]);
  const observerRef = useRef(null);
  const intersectingPagesRef = useRef(new Map());
  const visibleIndexRef = useRef(visibleIndex);
  visibleIndexRef.current = visibleIndex;
  const preloadTriggeredRef = useRef(false);
  const progressDebouncerRef = useRef(null);
  if (!progressDebouncerRef.current) {
    progressDebouncerRef.current = createProgressDebouncer((position) =>
      updateLastReadPosition(
        position.seriesTitle,
        position.chapterNumber,
        position.pageIndex,
        position.totalPages,
      ), 500);
  }

  const useLazy = config?.lazyLoading !== false;
  const preloadNext = config?.preloadNextChapter !== false;
  const progressKey =
    series && chapter ? `${series.title}/${chapter.number}` : null;

  useEffect(() => () => {
    void progressDebouncerRef.current?.flush();
  }, [progressKey]);

  useEffect(() => {
    let cancelled = false;
    if (!chapter) return;

    setPages([]);
    setError(null);
    setVisibleIndex(0);
    setShowEndOverlay(false);
    setLoadedSet(new Set());
    setPageHeights([]);
    preloadTriggeredRef.current = false;
    pageRefs.current = [];
    intersectingPagesRef.current.clear();

    (async () => {
      let filePaths = [];
      try {
        filePaths = await window.strip.chapter.pages(chapter.directory);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
        return;
      }
      if (cancelled) return;

      const urls = filePaths.map((p) => toFileUrl(p));
      setPages(urls);

      let sp = scrollToPage;
      if (!sp) {
        try {
          sp = (await window.strip.progress.get(progressKey)) || 0;
        } catch (_) {
          sp = 0;
        }
      }
      const restoredPage = Math.max(0, Math.min(urls.length - 1, Number(sp) || 0));
      if (!cancelled) {
        setStartPage(restoredPage);
        setVisibleIndex(restoredPage);
      }

      if (!useLazy) {
        setLoadedSet(new Set(urls.map((_, i) => i)));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.directory]);

  const readerWindow = getReaderWindow(pages.length, visibleIndex, 4);
  const spacerHeights = getWindowSpacerHeights(
    pageHeights, readerWindow.start, readerWindow.end,
  );

  function preloadNextChapter() {
    if (!series || !chapter) return;
    const idx = series.chapters.findIndex((c) => c.number === chapter.number);
    if (idx === -1 || idx >= series.chapters.length - 1) return;
    const nextCh = series.chapters[idx + 1];
    window.strip.chapter
      .pages(nextCh.directory)
      .then((filePaths) => {
        filePaths.slice(0, 3).forEach((p) => {
          const img = new Image();
          img.src = toFileUrl(p);
        });
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (!pages.length) return;
    if (observerRef.current) observerRef.current.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const idx = Number(entry.target.dataset.pageIndex);
          if (!entry.isIntersecting) {
            intersectingPagesRef.current.delete(idx);
            return;
          }
          intersectingPagesRef.current.set(idx, {
            index: idx,
            top: entry.boundingClientRect.top - (entry.rootBounds?.top || 0),
          });

          if (useLazy) {
            setLoadedSet((prev) => {
              if (prev.has(idx)) return prev;
              const next = new Set(prev);
              next.add(idx);
              return next;
            });
          }

          if (
            preloadNext &&
            !preloadTriggeredRef.current &&
            idx >= pages.length - 5
          ) {
            preloadTriggeredRef.current = true;
            preloadNextChapter();
          }
        });
        setVisibleIndex(getVisiblePageIndex(
          [...intersectingPagesRef.current.values()], visibleIndexRef.current,
        ));
      },
      { root: containerRef.current, rootMargin: "500px 0px", threshold: 0 },
    );

    pageRefs.current.forEach((el) => el && observer.observe(el));
    observerRef.current = observer;

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, useLazy, preloadNext, readerWindow.start, readerWindow.end]);

  useEffect(() => {
    if (!pages.length || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setPageHeights((previous) => {
        let next = previous;
        for (const entry of entries) {
          const index = Number(entry.target.dataset.pageIndex);
          const height = entry.contentRect.height;
          if (!Number.isFinite(index) || !Number.isFinite(height) || height <= 0) continue;
          if (Math.abs((next[index] || 0) - height) < 1) continue;
          if (next === previous) next = [...previous];
          next[index] = height;
        }
        return next;
      });
    });
    for (let index = readerWindow.start; index <= readerWindow.end; index++) {
      const element = pageRefs.current[index];
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [pages.length, readerWindow.start, readerWindow.end]);

  useEffect(() => {
    if (!pages.length || startPage <= 0 || startPage >= pages.length) return;
    const t = setTimeout(() => {
      pageRefs.current[startPage]?.scrollIntoView({ behavior: "auto" });
    }, 200);
    return () => clearTimeout(t);
  }, [pages, startPage]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (progressKey) {
      progressDebouncerRef.current.schedule({
        seriesTitle: series.title,
        chapterNumber: chapter.number,
        pageIndex: visibleIndex,
        totalPages: pages.length,
      });
    }

    const distFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowEndOverlay((prev) => {
      if (!prev && distFromBottom < 120) return true;
      if (prev && distFromBottom > 180) return false;
      return prev;
    });
  }, [progressKey, series, chapter, pages.length, visibleIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    function onKeydown(e) {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const key = e.key.toLowerCase();

      if (key === "escape" || key === "g") {
        e.preventDefault();
        onBack();
        return;
      }
      if (key === "b") {
        e.preventDefault();
        onExitToLibrary();
        return;
      }
      if (key === "n" || key === "j") {
        e.preventDefault();
        onNavigateChapter(1);
        return;
      }
      if (key === "p" || key === "k") {
        e.preventDefault();
        onNavigateChapter(-1);
        return;
      }

      const container = containerRef.current;
      if (!container) return;
      if (key === "arrowdown" || key === "arrowright") {
        e.preventDefault();
        container.scrollBy({
          top: window.innerHeight * 0.85,
          behavior: "smooth",
        });
      } else if (key === "arrowup" || key === "arrowleft") {
        e.preventDefault();
        container.scrollBy({
          top: -window.innerHeight * 0.85,
          behavior: "smooth",
        });
      }
    }

    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [onBack, onExitToLibrary, onNavigateChapter]);

  if (!series || !chapter) {
    return (
      <section id="view-reader" className="view reader-view active">
        <p className="muted" style={{ padding: 32 }}>
          No chapter selected.
        </p>
      </section>
    );
  }

  const idx = series.chapters.findIndex((c) => c.number === chapter.number);
  const hasPrev = idx > 0;
  const hasNext = idx !== -1 && idx < series.chapters.length - 1;

  return (
    <section id="view-reader" className="view reader-view active">
      <div id="reader-toolbar">
        <button className="btn btn-ghost" onClick={onBack}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <div className="reader-chapter-nav">
          <button
            className="btn btn-ghost icon-btn"
            title="Previous chapter (P)"
            disabled={!hasPrev}
            onClick={() => onNavigateChapter(-1)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="reader-title-text">
            {series.title} · Chapter {chapter.number}
          </span>
          <button
            className="btn btn-ghost icon-btn"
            title="Next chapter (N)"
            disabled={!hasNext}
            onClick={() => onNavigateChapter(1)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
        <div className="reader-controls">
          <span>
            {pages.length > 0 ? `${visibleIndex + 1} / ${pages.length}` : ""}
          </span>
        </div>
      </div>

      <div id="reader-container" ref={containerRef}>
        <div id="reader-pages">
          {error && (
            <div className="reader-page-error">
              Could not load pages: {error}
            </div>
          )}
          {!error && pages.length === 0 && (
            <div className="reader-page-error">
              No pages found in this chapter.
            </div>
          )}
          <div aria-hidden="true" style={{ height: spacerHeights.before }} />
          {pages.slice(readerWindow.start, readerWindow.end + 1).map((src, offset) => {
            const i = readerWindow.start + offset;
            return (
            <PageImage
              key={i}
              src={src}
              index={i}
              eager={!useLazy}
              loaded={loadedSet.has(i)}
              wrapperRef={(el) => (pageRefs.current[i] = el)}
            />
            );
          })}
          <div aria-hidden="true" style={{ height: spacerHeights.after }} />
        </div>
      </div>

      <div
        id="chapter-end-overlay"
        className={showEndOverlay ? "is-visible" : ""}
        aria-hidden={!showEndOverlay}
      >
        <div className="chapter-end-card">
          <div className="chapter-end-label">End of chapter</div>
          <div className="chapter-end-title">
            {series.title} · Chapter {chapter.number}
          </div>
          <div className="chapter-end-actions">
            <button
              className="btn btn-ghost"
              disabled={!hasPrev}
              onClick={() => onNavigateChapter(-1)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ width: 15, height: 15 }}
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Previous
            </button>
            <button className="btn btn-ghost" onClick={onBack}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ width: 15, height: 15 }}
              >
                <rect x="3" y="3" width="7" height="9" rx="1" />
                <rect x="14" y="3" width="7" height="5" rx="1" />
                <rect x="14" y="12" width="7" height="9" rx="1" />
                <rect x="3" y="16" width="7" height="5" rx="1" />
              </svg>
              Chapter list
            </button>
            <button
              className="btn btn-primary"
              disabled={!hasNext}
              onClick={() => onNavigateChapter(1)}
            >
              Next chapter
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ width: 15, height: 15 }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
