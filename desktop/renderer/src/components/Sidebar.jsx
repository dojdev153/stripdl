// desktop/renderer/src/components/Sidebar.jsx
//
// Same markup as before; the Download nav-item now shows a live badge
// (active job count) and its click handler drives the real tray via
// DownloadTrayContext instead of a placeholder callback.

import React from "react";
import { applyTheme } from "../lib/theme.js";
import { useDownloadTray } from "../context/DownloadTrayContext.jsx";

export default function Sidebar({ currentView, onNavigate }) {
  const { handleNavClick, activeJobCount } = useDownloadTray();

  function toggleTheme() {
    const next =
      document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    window.strip.theme.set(next);
    window.strip.config.set({ theme: next });
  }

  return (
    <nav id="sidebar">
      <div className="sidebar-logo">
        <span className="logo-mark">◈</span>
        <span className="logo-text">strip</span>
      </div>
      <ul className="nav-links">
        <li>
          <a
            href="#"
            className={`nav-link ${currentView === "library" ? "active" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              onNavigate("library");
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <rect x="3" y="3" width="7" height="9" rx="1" />
              <rect x="14" y="3" width="7" height="5" rx="1" />
              <rect x="14" y="12" width="7" height="9" rx="1" />
              <rect x="3" y="16" width="7" height="5" rx="1" />
            </svg>
            Library
          </a>
        </li>
        <li>
          <a
            href="#"
            className="nav-link"
            id="nav-download"
            onClick={(e) => {
              e.preventDefault();
              handleNavClick();
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M12 3v13M7 11l5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
            Download
            {activeJobCount > 0 && (
              <span className="nav-download-badge" id="nav-download-badge">
                {activeJobCount}
              </span>
            )}
          </a>
        </li>
        <li>
          <a
            href="#"
            className={`nav-link ${currentView === "settings" ? "active" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              onNavigate("settings");
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
            </svg>
            Settings
          </a>
        </li>
      </ul>
      <div className="sidebar-footer">
        <button id="theme-toggle" title="Toggle theme" onClick={toggleTheme}>
          <svg
            className="icon-sun"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg
            className="icon-moon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
