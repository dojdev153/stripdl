// desktop/main/index.js
// Main process: windows, IPC, Python CLI subprocess, context menus, scheduler.

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  Menu,
  Notification,
  powerMonitor,
  protocol,
  net,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");
const { buildDownloadConfigArgs } = require("./configKeys");
const { startScheduler } = require("./scheduler");
const { assertLibraryPath, assertSeriesPath, assertChapterPath } = require("./pathSafety.cjs");
const { createLineDecoder, summarizeDownloadFailure } = require("./downloadOutput.cjs");
const { createProgressPersistence } = require("./progressPersistence.cjs");
const { scanLibrary } = require("./libraryScanner.cjs");

const isDev =
  process.argv.includes("--dev") || !!process.env.ELECTRON_RENDERER_URL;

// ──────────────────────────────────────────────────────────────────
//  Custom "strip-file://" protocol — serves local files (covers, chapter
//  pages) to the renderer regardless of how the renderer page itself was
//  loaded (needed because a page loaded over http://, as in `npm run
//  dev`'s Vite dev server, is blocked from loading file:// resources
//  outright — a Chromium origin-level restriction, independent of CSP).
//
//  URL SHAPE: "strip-file://local-file/<percent-encoded full real path>".
//  A prior version used a three-slash, empty-host format mimicking
//  file:// URLs — but that empty-host convention is special-cased by
//  Chromium ONLY for the literal "file" scheme, not custom protocols.
//  For a Windows path, that caused the drive letter to be silently
//  swallowed into a bogus URL host on every single request (see
//  renderer/src/lib/fileUrl.js for the full explanation — matching
//  fileUrl.js on the renderer side builds URLs in this same shape).
//
//  Using a fixed non-empty host plus the ENTIRE real path as one
//  percent-encoded opaque path segment means nothing in the URL can be
//  misread as a host, port, or path separator — so decoding is exactly
//  the reverse: take the one path segment, decode it, and that's the
//  original path string, unchanged (no platform-specific drive-letter
//  slicing needed, unlike the previous version).
//
//  registerSchemesAsPrivileged() MUST run before app 'ready' — hence
//  module-level, not inside whenReady().
// ──────────────────────────────────────────────────────────────────

protocol.registerSchemesAsPrivileged([
  {
    scheme: "strip-file",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

function registerStripFileProtocol() {
  protocol.handle("strip-file", async (request) => {
    try {
      const url = new URL(request.url);
      // pathname is "/" + the single encodeURIComponent'd path segment
      // built by renderer/src/lib/fileUrl.js — decoding it recovers the
      // exact original path string (backslashes, drive letter, spaces,
      // unicode, all intact), no reconstruction needed.
      const filePath = decodeURIComponent(url.pathname.slice(1));
      const safeFilePath = await assertLibraryPath(filePath, appConfig.downloadDir);
      // Awaited (not just returned) so a fetch failure — e.g. the file
      // genuinely doesn't exist — is caught here and turned into a
      // readable error response, instead of becoming an unhandled
      // promise rejection that surfaces to the renderer as an opaque
      // net::ERR_UNEXPECTED with no diagnostic information.
      return await net.fetch(pathToFileURL(safeFilePath).toString());
    } catch (e) {
      return new Response(`strip-file protocol error: ${e.message}`, {
        status: 404,
      });
    }
  });
}

// ──────────────────────────────────────────────────────────────────
//  Config persistence
// ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH))
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {}
  return {
    downloadDir: path.join(app.getPath("home"), "strip-data"),
    theme: "system",
    readingProgress: {},
    maxConcurrentJobs: 2,
    maxConcurrentChapters: 3,
    imageConcurrency: 4,
    rateLimit: 8,
    cacheTtlDays: 7,
    verifyIntegrity: false,
    overwrite: false,
    lazyLoading: true,
    preloadNextChapter: true,
    schedules: {},
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

let appConfig = loadConfig();
if (!appConfig.schedules) appConfig.schedules = {};

async function writeConfigAtomic(nextConfig) {
  const tempPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(nextConfig, null, 2), "utf8");
    await fs.promises.rename(tempPath, CONFIG_PATH);
    appConfig = nextConfig;
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

const progressPersistence = createProgressPersistence({
  getConfig: () => appConfig,
  writeConfigAtomic,
});
let allowQuitAfterProgressFlush = false;

// ──────────────────────────────────────────────────────────────────
//  Window management
// ──────────────────────────────────────────────────────────────────

let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f5f1e6",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  if (isDev) mainWindow.webContents.openDevTools();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerStripFileProtocol();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  initScheduler();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (scheduler) scheduler.stop();
  if (allowQuitAfterProgressFlush) return;
  event.preventDefault();
  progressPersistence.flush().finally(() => {
    allowQuitAfterProgressFlush = true;
    app.quit();
  });
});

// ──────────────────────────────────────────────────────────────────
//  Resolve Python CLI path
// ──────────────────────────────────────────────────────────────────

function getStripCliPath() {
  if (app.isPackaged) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const bundled = path.join(
      process.resourcesPath,
      "strip-cli",
      `stripdl${ext}`,
    );
    if (fs.existsSync(bundled)) return bundled;
  }
  return "stripdl";
}

// ──────────────────────────────────────────────────────────────────
//  IPC — Config
// ──────────────────────────────────────────────────────────────────

ipcMain.handle("config:get", () => appConfig);

ipcMain.handle("config:set", (_, updates) => {
  appConfig = { ...appConfig, ...updates };
  saveConfig(appConfig);
  return appConfig;
});

// ──────────────────────────────────────────────────────────────────
//  IPC — Library scanning
// ──────────────────────────────────────────────────────────────────

ipcMain.handle("library:scan", () => scanLibrary(appConfig.downloadDir));

// ──────────────────────────────────────────────────────────────────
//  IPC — Chapter pages
// ──────────────────────────────────────────────────────────────────

ipcMain.handle("chapter:pages", async (_, chapterDir) => {
  const safeChapterDir = await assertChapterPath(chapterDir, appConfig.downloadDir);
  const names = await fs.promises.readdir(safeChapterDir);
  const pages = [];
  for (const name of names.filter((f) => f.endsWith(".jpg") && !f.startsWith("cover")).sort()) {
    pages.push(await assertLibraryPath(path.join(safeChapterDir, name), appConfig.downloadDir));
  }
  return pages;
});

// ──────────────────────────────────────────────────────────────────
//  IPC — Reading progress
// ──────────────────────────────────────────────────────────────────

// NOTE: this handler backs two different value shapes under one channel —
// plain numeric page-index progress ("<title>/<chapterNumber>", where 0 is
// a legitimate "no progress yet" value) and the "<title>/lastRead" key
// (meant to be an object, or absent entirely for a never-opened series).
// Returning `?? 0` here used to coerce a missing lastRead into the number
// 0 instead of an honest "nothing stored," which downstream renderer code
// then rendered as a stray literal "0" in the UI. Returning `?? null`
// keeps "missing" unambiguous regardless of which shape the caller
// expects; callers that want a numeric fallback (e.g. per-chapter
// progress) now apply `?? 0` themselves on the resolved value.
ipcMain.handle(
  "progress:get",
  (_, key) => appConfig.readingProgress?.[key] ?? null,
);

ipcMain.handle("progress:savePosition", (_, position) =>
  progressPersistence.saveReadingPosition(position),
);

// ──────────────────────────────────────────────────────────────────
//  IPC — Downloads
// ──────────────────────────────────────────────────────────────────

const activeDownloads = new Map();

function spawnDownload({ url, chapters, downloadDir, extraArgs = [] }) {
  const args = ["download", url, "--json-progress"];
  if (chapters) args.push("--chapters", chapters);
  args.push("--output", appConfig.downloadDir);
  args.push(...buildDownloadConfigArgs(appConfig));
  args.push(...extraArgs);

  const cliPath = getStripCliPath();
  const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  let downloadedCount = 0;
  let hadError = false;
  let partial = false;
  let errorMessage = null;
  let stderrTail = "";

  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("download:progress", {
        downloadId,
        ...payload,
      });
  };

  const done = new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliPath, args, { env: { ...process.env } });
    } catch (e) {
      resolve({ downloadedCount: 0, hadError: true, errorMessage: e.message });
      return;
    }

    activeDownloads.set(downloadId, child);

    child.on("error", (e) => {
      hadError = true;
      errorMessage = summarizeDownloadFailure({ status: "error", message: e.message }, "", 1);
      send({ status: "error", message: e.message, failureMessage: errorMessage });
      activeDownloads.delete(downloadId);
      resolve({ downloadedCount, hadError, partial, errorMessage });
    });

    const decodeLine = createLineDecoder((line) => {
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch (_) {
          send({ status: "log", message: line });
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          send({ status: "log", message: line });
          return;
        }
        if (parsed.status === "chapter_done") downloadedCount++;
        if (parsed.status === "chapter_error") {
          partial = true;
          hadError = true;
          errorMessage = summarizeDownloadFailure(parsed, stderrTail, 1);
          parsed.failureMessage = errorMessage;
        } else if (parsed.status === "partial") {
          partial = true;
          hadError = true;
          errorMessage = summarizeDownloadFailure(parsed, stderrTail, 1);
          parsed.failureMessage = errorMessage;
        } else if (parsed.status === "error") {
          hadError = true;
          errorMessage = summarizeDownloadFailure(parsed, stderrTail, 1);
          parsed.failureMessage = errorMessage;
        }
        send(parsed);
    });
    child.stdout.on("data", decodeLine);

    child.stderr.on("data", (data) => {
      const detail = data.toString();
      stderrTail = (stderrTail + detail).slice(-8192);
      send({ status: "diagnostic", message: detail });
    });

    child.on("close", (code) => {
      decodeLine.end();
      activeDownloads.delete(downloadId);
      if (code !== 0 && !hadError) {
        hadError = true;
        errorMessage = summarizeDownloadFailure(null, stderrTail, code);
      }
      send({ status: "process_exit", code, errorMessage });
      resolve({ downloadedCount, hadError, partial, errorMessage });
    });
  });

  return { downloadId, done };
}

ipcMain.handle("download:start", (event, { url, chapters, downloadDir }) => {
  const { downloadId } = spawnDownload({ url, chapters, downloadDir });
  return downloadId;
});

ipcMain.handle("download:cancel", (_, downloadId) => {
  const child = activeDownloads.get(downloadId);
  if (child) {
    child.kill();
    activeDownloads.delete(downloadId);
    return true;
  }
  return false;
});

ipcMain.handle("download:active", () => [...activeDownloads.keys()]);

// ──────────────────────────────────────────────────────────────────
//  Scheduler — per-series "auto-download on release day"
// ──────────────────────────────────────────────────────────────────

let scheduler = null;

function notifySchedule(entry, result) {
  const title = entry.title || "Series";

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("schedule:event", {
      title,
      downloaded: result.downloadedCount || 0,
      error: result.errorMessage || null,
    });
  }

  if (!Notification.isSupported()) return;
  if (result.hadError) {
    new Notification({
      title: `Strip — couldn't check ${title}`,
      body: result.errorMessage || "Auto-download check failed.",
    }).show();
  } else if (result.downloadedCount > 0) {
    new Notification({
      title: `${title} — new chapter${result.downloadedCount > 1 ? "s" : ""}!`,
      body: `${result.downloadedCount} new chapter${result.downloadedCount > 1 ? "s" : ""} downloaded.`,
    }).show();
  }
}

function initScheduler() {
  scheduler = startScheduler({
    getSchedules: () => appConfig.schedules,
    updateSchedule: (seriesKey, patch) => {
      if (!appConfig.schedules[seriesKey]) return;
      appConfig.schedules[seriesKey] = {
        ...appConfig.schedules[seriesKey],
        ...patch,
      };
      saveConfig(appConfig);
    },
    runCheck: async (seriesKey, entry) => {
      const { done } = spawnDownload({
        url: entry.url,
        downloadDir: appConfig.downloadDir,
      });
      const result = await done;
      notifySchedule(entry, result);
      return {
        downloaded: result.downloadedCount,
        error: result.hadError ? result.errorMessage : undefined,
        partial: result.partial,
      };
    },
  });

  powerMonitor.on("resume", () => scheduler.runNow());
}

ipcMain.handle("schedule:get", () => appConfig.schedules);

ipcMain.handle("schedule:set", (_, seriesKey, patch) => {
  const existing = appConfig.schedules[seriesKey] || {};
  appConfig.schedules[seriesKey] = { ...existing, ...patch };
  saveConfig(appConfig);
  return appConfig.schedules[seriesKey];
});

ipcMain.handle("schedule:runNow", async () => {
  if (scheduler) await scheduler.runNow();
  return true;
});

// ──────────────────────────────────────────────────────────────────
//  IPC — File system operations
// ──────────────────────────────────────────────────────────────────

ipcMain.handle("fs:deleteSeries", async (_, seriesDir) => {
  try {
    const safePath = await assertSeriesPath(seriesDir, appConfig.downloadDir);
    await fs.promises.rm(safePath, { recursive: true, force: true });
    return { success: true, directory: safePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("fs:deleteChapter", async (_, chapterDir) => {
  try {
    const safePath = await assertChapterPath(chapterDir, appConfig.downloadDir);
    await fs.promises.rm(safePath, { recursive: true, force: true });
    return { success: true, directory: safePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("fs:openFolder", async (_, dirPath) => {
  const safePath = await assertLibraryPath(dirPath, appConfig.downloadDir);
  return shell.openPath(safePath);
});

// ──────────────────────────────────────────────────────────────────
//  IPC — Context menus
// ──────────────────────────────────────────────────────────────────

ipcMain.handle("menu:seriesContext", async (_, { seriesDir, seriesTitle }) => {
  seriesDir = await assertLibraryPath(seriesDir, appConfig.downloadDir);
  return new Promise((resolve) => {
    const template = [
      {
        label: "Open folder in explorer",
        click: () => {
          shell.openPath(seriesDir);
          resolve(null);
        },
      },
      { type: "separator" },
      {
        label: "Delete series…",
        click: () => resolve("delete"),
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow, callback: () => resolve(null) });
  });
});

ipcMain.handle("menu:chapterContext", async (_, { chapterDir, chapterNumber }) => {
  chapterDir = await assertLibraryPath(chapterDir, appConfig.downloadDir);
  return new Promise((resolve) => {
    const template = [
      {
        label: "Open folder in explorer",
        click: () => {
          shell.openPath(chapterDir);
          resolve(null);
        },
      },
      { type: "separator" },
      { label: "Mark as read", click: () => resolve("mark_read") },
      { label: "Delete chapter…", click: () => resolve("delete") },
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow, callback: () => resolve(null) });
  });
});

// ──────────────────────────────────────────────────────────────────
//  IPC — Dialog & Theme
// ──────────────────────────────────────────────────────────────────

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result.filePaths[0] ?? null;
});

ipcMain.handle("theme:get", () =>
  nativeTheme.shouldUseDarkColors ? "dark" : "light",
);

ipcMain.handle("theme:set", (_, theme) => {
  nativeTheme.themeSource = theme;
  appConfig.theme = theme;
  saveConfig(appConfig);
});
