// desktop/renderer/src/views/SettingsView.jsx
//
// Full port of the old Settings view (index.html markup + app.js's
// loadSettings/saveSettingValue functions). Every field, default, and
// min/max/step matches the original exactly.

import React, { useEffect, useState } from "react";
import { useConfig } from "../hooks/useConfig.js";
import { applyTheme } from "../lib/theme.js";

/**
 * Number input that commits on blur (matching the native <input> "change"
 * event the old vanilla-JS version listened for) rather than on every
 * keystroke, so we're not firing an IPC config:set call per digit typed.
 */
function NumberSetting({ label, desc, value, onCommit, min, max, step }) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc muted">{desc}</div>}
      </div>
      <input
        type="number"
        className="input setting-num"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onCommit(local)}
      />
    </div>
  );
}

function BoolSetting({ label, desc, checked, onChange }) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-label">{label}</div>
        {desc && <div className="setting-desc muted">{desc}</div>}
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-slider" />
      </label>
    </div>
  );
}

export default function SettingsView() {
  const { config, updateConfig } = useConfig();

  if (!config) {
    return (
      <section id="view-settings" className="view active">
        <header className="view-header">
          <h1>Settings</h1>
        </header>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  async function changeFolder() {
    const folder = await window.strip.dialog.openFolder();
    if (folder) updateConfig({ downloadDir: folder });
  }

  function changeTheme(theme) {
    applyTheme(theme);
    window.strip.theme.set(theme);
    updateConfig({ theme });
  }

  return (
    <section id="view-settings" className="view active">
      <header className="view-header">
        <h1>Settings</h1>
      </header>
      <div className="settings-wrap">
        {/* Storage */}
        <div className="settings-group card">
          <h2 className="settings-group-title">Storage</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">Download folder</div>
              <div className="setting-value muted">
                {config.downloadDir ?? "~"}
              </div>
            </div>
            <button className="btn btn-secondary" onClick={changeFolder}>
              Change
            </button>
          </div>
        </div>

        {/* Downloads */}
        <div className="settings-group card">
          <h2 className="settings-group-title">Downloads</h2>
          <NumberSetting
            label="Concurrent chapters"
            desc="Number of chapters to download in parallel."
            min={1}
            max={10}
            value={config.maxConcurrentChapters ?? 3}
            onCommit={(v) =>
              updateConfig({ maxConcurrentChapters: parseInt(v, 10) || 3 })
            }
          />
          <NumberSetting
            label="Concurrent images"
            desc="Images downloaded at once per chapter."
            min={1}
            max={16}
            value={config.imageConcurrency ?? 4}
            onCommit={(v) =>
              updateConfig({ imageConcurrency: parseInt(v, 10) || 4 })
            }
          />
          <NumberSetting
            label="Rate limit (req/sec)"
            desc="Max requests per second across all threads."
            min={1}
            max={30}
            step={0.5}
            value={config.rateLimit ?? 8}
            onCommit={(v) => updateConfig({ rateLimit: parseFloat(v) || 8 })}
          />
          <NumberSetting
            label="Metadata cache (days)"
            desc="Re-use cached series info for this many days. Set 0 to always refresh."
            min={0}
            max={365}
            value={config.cacheTtlDays ?? 7}
            onCommit={(v) =>
              updateConfig({ cacheTtlDays: parseInt(v, 10) || 0 })
            }
          />
          <BoolSetting
            label="Verify image integrity"
            desc="Check SHA-256 of each image on resume (slower)."
            checked={config.verifyIntegrity ?? false}
            onChange={(v) => updateConfig({ verifyIntegrity: v })}
          />
          <BoolSetting
            label="Overwrite existing chapters"
            desc="Re-download chapters even if already marked complete."
            checked={config.overwrite ?? false}
            onChange={(v) => updateConfig({ overwrite: v })}
          />
          <NumberSetting
            label="Max simultaneous jobs"
            desc="Queue additional jobs beyond this limit."
            min={1}
            max={5}
            value={config.maxConcurrentJobs ?? 2}
            onCommit={(v) =>
              updateConfig({ maxConcurrentJobs: parseInt(v, 10) || 2 })
            }
          />
        </div>

        {/* Reader */}
        <div className="settings-group card">
          <h2 className="settings-group-title">Reader</h2>
          <BoolSetting
            label="Lazy load images"
            desc="Load images only as you scroll (reduces memory)."
            checked={config.lazyLoading !== false}
            onChange={(v) => updateConfig({ lazyLoading: v })}
          />
          <BoolSetting
            label="Preload next chapter"
            desc="Start loading the next chapter near the end."
            checked={config.preloadNextChapter !== false}
            onChange={(v) => updateConfig({ preloadNextChapter: v })}
          />
        </div>

        {/* Appearance */}
        <div className="settings-group card">
          <h2 className="settings-group-title">Appearance</h2>
          <div className="setting-row">
            <div className="setting-label">Theme</div>
            <select
              className="select"
              value={config.theme ?? "system"}
              onChange={(e) => changeTheme(e.target.value)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>

        {/* About */}
        <div className="settings-group card">
          <h2 className="settings-group-title">About</h2>
          <p className="muted">
            strip v0.3.1 — webtoon downloader &amp; reader
          </p>
        </div>
      </div>
    </section>
  );
}
