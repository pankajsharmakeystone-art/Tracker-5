// electron/main.js
// Version: Continuous Recording on Idle Fix
// Changes:
// 1. REMOVED all "Stop Recording" logic from the Idle Detection block. (Recording now continues during idle).
// 2. ADDED a check (!isRecordingActive) in the "Return from Idle" block. (Prevents "Already Active" error if recording never stopped).
// 3. ADDED a check (!isRecordingActive) in the Manual "End Break" handler. (Safety check to prevent double-start errors).

const { app, BrowserWindow, ipcMain, desktopCapturer, powerMonitor, Tray, Menu, nativeImage, screen, dialog, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fetch = require("node-fetch");
const electronLog = require("electron-log");
const { DateTime } = require("luxon");

// auto-updater
const { autoUpdater } = require("electron-updater");

const isDev = process.env.ELECTRON_DEV === 'true' || process.env.NODE_ENV === 'development';

electronLog.initialize?.();
if (electronLog?.transports?.file) {
  electronLog.transports.file.level = "info";
}
autoUpdater.logger = electronLog;
autoUpdater.autoDownload = true;

// ---------- HELPER FUNCTIONS ----------
function log(...args){ console.log("[electron]", ...args); }

function emitAutoUpdateStatus(event, payload = {}) {
  const safePayload = payload || {};
  log(`[autoUpdater] ${event}`, safePayload);
  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("auto-update-status", { event, ...safePayload });
    }
  } catch (e) {
    log("auto-update status emit failed", e.message);
  }
}

// ---------- LOAD ENV + FIREBASE CLIENT ----------
const firebase = require("firebase/compat/app");
require("firebase/compat/auth");
require("firebase/compat/firestore");

const potentialEnvFiles = [];

if (process.resourcesPath) {
  potentialEnvFiles.push(
    path.join(process.resourcesPath, ".env.desktop"),
    path.join(process.resourcesPath, ".env.local"),
    path.join(process.resourcesPath, ".env")
  );
}

potentialEnvFiles.push(
  path.join(__dirname, "..", ".env.desktop"),
  path.join(__dirname, "..", ".env.local"),
  path.join(__dirname, "..", ".env")
);

function hydrateEnv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      if (!line || /^\s*#/.test(line)) return;
      const idx = line.indexOf("=");
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      if (!key || process.env[key]) return;
      const value = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
      process.env[key] = value;
    });
  } catch (err) {
    log("Failed to hydrate env from", filePath, err.message);
  }
}

potentialEnvFiles.forEach(hydrateEnv);

const devToolsEnabled = (process.env.ALLOW_DESKTOP_DEVTOOLS === 'true') || isDev;

const envOr = (...keys) => {
  for (const key of keys) {
    if (process.env[key]) return process.env[key];
  }
  return "";
};

const firebaseConfig = {
  apiKey: envOr("FIREBASE_API_KEY", "VITE_FIREBASE_API_KEY"),
  authDomain: envOr("FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: envOr("FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID"),
  storageBucket: envOr("FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: envOr("FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: envOr("FIREBASE_APP_ID", "VITE_FIREBASE_APP_ID")
};

const missingFirebaseKeys = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingFirebaseKeys.length) {
  const message = `Missing Firebase client config: ${missingFirebaseKeys.join(", ")}`;
  log("FATAL:", message);
  dialog.showErrorBox("Firebase Config Error", `${message}\n\nSet the values via environment variables.`);
  process.exit(1);
}

let firebaseApp;
try {
  firebaseApp = firebase.initializeApp(firebaseConfig);
  log("Firebase client initialized (project:", firebaseConfig.projectId, ")");
} catch (e) {
  log("FATAL: Could not initialize Firebase client:", e.message);
  dialog.showErrorBox("Firebase Initialization Error", `Could not initialize Firebase client SDK: ${e.message}`);
  process.exit(1);
}

const clientAuth = firebase.auth();
const db = firebase.firestore();
const FieldValue = firebase.firestore.FieldValue;
const Timestamp = firebase.firestore.Timestamp;
const DEFAULT_ORGANIZATION_TIMEZONE = "Asia/Kolkata";

// ---------- CONFIG ----------
const RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Path to the uploaded icon you asked to use for the popup
const POPUP_ICON_PATH = "/mnt/data/a35a616b-074d-4238-a09e-5dcb70efb649.png"; 

// ---------- GLOBALS ----------
let mainWindow = null;
let tray = null;
let isQuiting = false;
let cachedAdminSettings = {};
const getOrganizationTimezone = () => cachedAdminSettings?.organizationTimezone || DEFAULT_ORGANIZATION_TIMEZONE;
let currentUid = null;
let commandUnsub = null;
let statusInterval = null;
let lastIdleState = false; // track previous idle state
let agentClockedIn = false; // only monitor idle when true
let isRecordingActive = false; // track recording
let popupWindow = null; // reference to the transient popup
let cachedDisplayName = null; // cached user displayName (filled on register)

let autoClockOutInterval = null;
let lastAutoClockOutTargetKey = null;
let agentStatusUnsub = null; // remote Firestore watch for agentStatus
let autoClockConfigUnsub = null;
let autoClockSlots = {};
let currentShiftDate = null;
let systemLocked = false;
let manualBreakActive = false;

// Dropbox token management
let cachedDropboxAccessToken = null;
let cachedDropboxRefreshToken = null;
let dropboxTokenExpiry = null;

// track manual-break timeout notifications per uid to avoid repeat spam
const manualBreakNotified = new Map();
const pendingAgentStatuses = [];

const buildDesktopStatusMetadata = () => ({
  lastUpdate: FieldValue.serverTimestamp(),
  appVersion: app.getVersion(),
  platform: process.platform,
  machineName: os.hostname(),
  isDesktopConnected: true
});

async function resumeRecordingIfNeeded(uid) {
  if (!uid) return;
  if (cachedAdminSettings?.recordingMode === 'auto' && cachedAdminSettings?.allowRecording) {
    if (!isRecordingActive) {
      isRecordingActive = true;
      await db.collection('agentStatus').doc(uid)
        .set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true })
        .catch(() => {});
      showRecordingPopup("Recording resumed");
      if (mainWindow && mainWindow.webContents) {
        try {
          mainWindow.webContents.send("command-start-recording", { uid });
        } catch (e) {
          log("Failed to signal renderer about recording resume", e?.message || e);
        }
      }
    } else {
      log("Recording already active, skipping auto resume.");
    }
  }
}

async function pushIdleStatus(uid, { idleSecs, reason } = {}) {
  if (!uid) return;
  await db.collection("agentStatus").doc(uid)
    .set({
      status: "break",
      isIdle: true,
      idleSecs,
      idleReason: reason || null,
      lockedBySystem: reason === 'system_lock',
      ...buildDesktopStatusMetadata()
    }, { merge: true })
    .catch(() => {});
}

async function pushActiveStatus(uid, { idleSecs } = {}) {
  if (!uid) return;
  await db.collection("agentStatus").doc(uid)
    .set({
      status: "online",
      isIdle: false,
      idleSecs,
      idleReason: FieldValue.delete(),
      lockedBySystem: false,
      ...buildDesktopStatusMetadata()
    }, { merge: true })
    .catch(() => {});
  await resumeRecordingIfNeeded(uid);
}

function registerSystemLockHandlers() {
  powerMonitor.on('lock-screen', async () => {
    log('System lock event detected');
    systemLocked = true;
    if (!currentUid || !agentClockedIn || manualBreakActive || lastIdleState) return;
    lastIdleState = true;
    await pushIdleStatus(currentUid, { idleSecs: powerMonitor.getSystemIdleTime(), reason: 'system_lock' });
  });

  powerMonitor.on('unlock-screen', async () => {
    log('System unlock event detected');
    systemLocked = false;
    if (!currentUid || !agentClockedIn || !lastIdleState) return;
    lastIdleState = false;
    await pushActiveStatus(currentUid, { idleSecs: powerMonitor.getSystemIdleTime() });
  });
}

autoUpdater.on("checking-for-update", () => emitAutoUpdateStatus("checking"));
autoUpdater.on("update-available", (info) => emitAutoUpdateStatus("available", { version: info?.version }));
autoUpdater.on("update-not-available", () => emitAutoUpdateStatus("up-to-date"));
autoUpdater.on("download-progress", (progress) => emitAutoUpdateStatus("downloading", {
  percent: Math.round(progress?.percent || 0),
  transferred: progress?.transferred,
  total: progress?.total
}));
autoUpdater.on("update-downloaded", (info) => emitAutoUpdateStatus("downloaded", { version: info?.version }));
autoUpdater.on("error", (error) => emitAutoUpdateStatus("error", { message: error?.message || String(error) }));

function getDropboxAppKey() {
  return cachedAdminSettings?.dropboxAppKey || process.env.DROPBOX_CLIENT_ID || process.env.DROPBOX_APP_KEY || "";
}

function getDropboxAppSecret() {
  return cachedAdminSettings?.dropboxAppSecret || process.env.DROPBOX_CLIENT_SECRET || process.env.DROPBOX_APP_SECRET || "";
}

function hasDropboxCredentials() {
  return Boolean(cachedDropboxRefreshToken || cachedDropboxAccessToken || cachedAdminSettings?.dropboxToken);
}

// ---------- CREATE MAIN WINDOW ----------
function registerDevtoolsShortcuts(windowInstance) {
  if (!devToolsEnabled || !windowInstance) return;
  const toggleDevtools = () => {
    const target = windowInstance?.webContents;
    if (!target) return;
    if (target.isDevToolsOpened()) {
      target.closeDevTools();
    } else {
      target.openDevTools({ mode: "detach" });
    }
  };
  try {
    globalShortcut.register("CommandOrControl+Shift+I", toggleDevtools);
    globalShortcut.register("F12", toggleDevtools);
  } catch (shortcutError) {
    log("Failed to register devtools shortcuts", shortcutError.message);
  }

  windowInstance.on("closed", () => {
    globalShortcut.unregister("CommandOrControl+Shift+I");
    globalShortcut.unregister("F12");
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false
  });

  // Dev/prod URL switching
  if (isDev) {
    mainWindow.loadURL('https://tracker-5.vercel.app');
  } else {
    // Load built Vite app (adjust path if needed)
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // Send handshake to renderer
  mainWindow.webContents.on("did-finish-load", () => {
    try { mainWindow.webContents.send("desktop-ready", { ok: true }); } catch(e) {}
  });

  mainWindow.once("ready-to-show", () => {
    if (!cachedAdminSettings?.requireLoginOnBoot) {
      mainWindow.show();
    }
    if (devToolsEnabled) {
      try {
        mainWindow.webContents.openDevTools({ mode: "detach" });
      } catch (devtoolsError) {
        log("Failed to open devtools", devtoolsError.message);
      }
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.on("close", (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  registerDevtoolsShortcuts(mainWindow);
}

// ---------- LOCK WINDOW ----------
// ---------- TRAY ----------
function createTray() {
  try {
    const iconPath = path.join(__dirname, "icon.png");
    const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
    tray = new Tray(image || undefined);
    const menu = Menu.buildFromTemplate([
      { label: "Open App", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: "Quit", click: () => { isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip("Workforce Desktop");
    tray.setContextMenu(menu);
    tray.on("click", () => { if (mainWindow) mainWindow.show(); });
  } catch(e) {
    log("tray init failed", e.message);
  }
}

function showAboutDialog() {
  try {
    const version = app.getVersion();
    const details = [
      `Version: ${version}`,
      `Electron: ${process.versions.electron}`,
      `Chrome: ${process.versions.chrome}`,
      `Node: ${process.versions.node}`
    ].join("\n");

    dialog.showMessageBox({
      title: `About ${app.getName()}`,
      message: `${app.getName()} Desktop`,
      detail: details,
      type: "info",
      buttons: ["Close"]
    });
  } catch (e) {
    log("about dialog failed", e.message);
  }
}

function buildAppMenu() {
  const template = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.getName(),
      submenu: [
        { label: `About ${app.getName()}`, click: showAboutDialog },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }

  template.push({
    label: "File",
    submenu: [
      { label: "Open App", click: () => { if (mainWindow) mainWindow.show(); } },
      { type: "separator" },
      process.platform === "darwin" ? { role: "close" } : { role: "quit" }
    ]
  });

  template.push({
    label: "Help",
    submenu: [
      { label: `About ${app.getName()}`, click: showAboutDialog }
    ]
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---------- POPUP (bottom-right) ----------
function showRecordingPopup(message) {
  // Only show if admin enabled the notification
  if (!cachedAdminSettings?.showRecordingNotification) return;

  try {
    // Close previous popup if present
    if (popupWindow) {
      try { popupWindow.close(); } catch(e){}
      popupWindow = null;
    }

    const display = screen.getPrimaryDisplay();
    const { width, height, workArea } = display; // workArea contains usable area
    const popupWidth = 320;
    const popupHeight = 80;
    const x = workArea.x + workArea.width - popupWidth - 16; // 16px margin
    const y = workArea.y + workArea.height - popupHeight - 16;

  popupWindow = new BrowserWindow({
    width: popupWidth,
    height: popupHeight,
    x,
    y,

    // ❗ MUST BE OUTSIDE APP WINDOW
    parent: null,
    modal: false,

    // ❗ Needed for OS-level floating window
    type: "toolbar",                   // <--- REQUIRED
    alwaysOnTop: true,
    skipTaskbar: true,
    frame: false,
    transparent: false,

    // Cannot be dismissed without clicking inside popup
    focusable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    resizable: false,

    webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
    }
  });

  // ⭐ Required: show on ALL workspaces (desktop)
  popupWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
  });

  // ⭐ Keeps popup on top even if user clicks anywhere else
  popupWindow.on("blur", () => {
      popupWindow.focus();
  });

    const safeIconUrl = `file://${POPUP_ICON_PATH}`;
    const html = `
      <html>
        <head>
          <meta charset="utf-8"/>
          <style>
            body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial; }
            .card {
              display:flex; align-items:center;
              background: rgba(20,20,20,0.95); color: #fff;
              border-radius:10px; padding:12px; box-shadow: 0 6px 18px rgba(0,0,0,0.4);
              width:100%; height:100%;
            }
            .icon { width:52px; height:52px; border-radius:8px; overflow:hidden; flex:0 0 52px; margin-right:12px; }
            .icon img { width:100%; height:100%; object-fit:cover; display:block; }
            .text { flex:1; }
            .title { font-size:14px; font-weight:600; margin-bottom:4px; }
            .sub { font-size:12px; opacity:0.85; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon"><img src="${safeIconUrl}" /></div>
            <div class="text">
              <div class="title">Recording</div>
              <div class="sub">${message}</div>
            </div>
          </div>
        </body>
      </html>
    `;
    popupWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    // Close after 4 seconds
    setTimeout(() => {
      if (popupWindow) {
        try { popupWindow.close(); } catch(e){}
        popupWindow = null;
      }
    }, 4000);
  } catch (e) {
    console.error("[electron] showRecordingPopup error", e);
  }
}

// ---------- HELPERS: DISPLAY NAME ----------
async function fetchDisplayName(uid) {
  try {
    if (!uid) return uid;
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc && userDoc.exists) {
      const d = userDoc.data();
      const raw = (d && (d.displayName || d.email)) ? (d.displayName || d.email) : uid;
      const safe = String(raw).replace(/[\/:\\*?"<>|]/g, '-').trim();
      return safe || uid;
    }
    return uid;
  } catch (e) {
    console.error("[fetchDisplayName] error", e);
    return uid;
  }
}

// ---------- ADMIN SETTINGS SYNC ----------
function applyAdminSettings(next) {
  cachedAdminSettings = next || {};
  log("adminSettings updated:", cachedAdminSettings);

  cachedDropboxRefreshToken = cachedAdminSettings?.dropboxRefreshToken || null;
  if (cachedDropboxRefreshToken) {
    log("[dropbox] refresh token cached");
  }

  if (Object.prototype.hasOwnProperty.call(cachedAdminSettings, "dropboxAccessToken")) {
    cachedDropboxAccessToken = cachedAdminSettings.dropboxAccessToken || null;
    if (cachedAdminSettings?.dropboxTokenExpiry) {
      dropboxTokenExpiry = new Date(cachedAdminSettings.dropboxTokenExpiry).getTime();
    } else {
      dropboxTokenExpiry = cachedDropboxAccessToken ? Date.now() + (4 * 60 * 60 * 1000) : null;
    }
    if (cachedDropboxAccessToken) {
      log("[dropbox] access token cached");
    }
  } else if (!cachedDropboxAccessToken && cachedAdminSettings?.dropboxToken) {
    cachedDropboxAccessToken = cachedAdminSettings.dropboxToken;
    dropboxTokenExpiry = null;
    log("[dropbox] legacy access token cached");
  }

  if (cachedAdminSettings.requireLoginOnBoot && !currentUid) {
    log("requireLoginOnBoot enabled, but lock window is disabled in this build");
  }

  if (mainWindow) mainWindow.webContents.send("settings-updated", cachedAdminSettings);

  if (agentClockedIn) {
    const updatedDateKey = toScheduleDateKey();
    if (currentShiftDate !== updatedDateKey) {
      currentShiftDate = updatedDateKey;
      lastAutoClockOutTargetKey = null;
    }
  }

  if (cachedAdminSettings?.autoClockOutEnabled) {
    startAutoClockOutWatcher();
  } else {
    stopAutoClockOutWatcher();
  }
}

// ---------- DESKTOP COMMANDS ----------
function startCommandsWatch(uid) {
  if (commandUnsub) { try { commandUnsub(); } catch(e){} commandUnsub = null; }
  if (!uid) return;

  const docRef = db.collection("desktopCommands").doc(uid);
  commandUnsub = docRef.onSnapshot(async snap => {
    if (!snap.exists) return;
    const cmd = snap.data();
    if (!cmd) return;

    if (cmd.startRecording) {
      log("command startRecording received");
      if (mainWindow) mainWindow.webContents.send("command-start-recording", { uid });
      // mark recording active and notify
      isRecordingActive = true;
      if (currentUid) await db.collection('agentStatus').doc(currentUid).set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
      showRecordingPopup("Recording started by admin");
      await db.collection("desktopCommands").doc(uid).update({ startRecording: false }).catch(()=>{});
    }

    if (cmd.stopRecording) {
      log("command stopRecording received");
      if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid });
      isRecordingActive = false;
      if (currentUid) await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
      showRecordingPopup("Recording stopped by admin");
      await db.collection("desktopCommands").doc(uid).update({ stopRecording: false }).catch(()=>{});
    }

    if (cmd.forceBreak) {
      log("force break cmd");
      await db.collection('agentStatus').doc(uid)
        .set({ status: "break", lastUpdate: FieldValue.serverTimestamp() }, { merge: true });
      await db.collection("desktopCommands").doc(uid).update({ forceBreak: false }).catch(()=>{});
    }

    if (cmd.bringOnline) {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      await db.collection("desktopCommands").doc(uid).update({ bringOnline: false }).catch(()=>{});
    }

    if (cmd.minimizeToTray) {
      if (mainWindow) mainWindow.hide();
      await db.collection("desktopCommands").doc(uid).update({ minimizeToTray: false }).catch(()=>{});
    }

    if (typeof cmd.setAutoLaunch !== "undefined") {
      app.setLoginItemSettings({ openAtLogin: !!cmd.setAutoLaunch });
      await db.collection("desktopCommands").doc(uid).update({ setAutoLaunch: FieldValue.delete() }).catch(()=>{});
    }
  });
}

// ---------- STATUS LOOP ----------
function startAgentStatusLoop(uid) {
  if (statusInterval) clearInterval(statusInterval);

  statusInterval = setInterval(async () => {
    if (!uid) return;

    try {
      // If not clocked in → only send heartbeat, no idle logic
      if (!agentClockedIn) {
        // Keep a minimal heartbeat so UI shows desktop connected when relevant
        await db.collection("agentStatus").doc(uid).set({
          isDesktopConnected: !!currentUid,
          lastUpdate: FieldValue.serverTimestamp(),
          appVersion: app.getVersion(),
          platform: process.platform,
          machineName: os.hostname()
        }, { merge: true }).catch(()=>{});
        return;
      }

      // -------------------------------
      // idleTimeout handling
      // -------------------------------
      let idleLimit = Number(cachedAdminSettings?.idleTimeout);

      // If invalid → default to 10, but do NOT treat 0 as invalid
      if (isNaN(idleLimit) || idleLimit < 0) {
        idleLimit = 10;
      }

      const idleSecs = powerMonitor.getSystemIdleTime();
      const timedOutIdle = idleLimit > 0 ? idleSecs >= idleLimit : false;
      const shouldForceIdle = systemLocked || timedOutIdle;
      const idleReason = systemLocked ? 'system_lock' : 'auto_idle';

      // Debug log
      console.log("⏱ Idle check → secs:", idleSecs, "limit:", idleLimit, "isIdle:", isIdle, "lastIdleState:", lastIdleState);

      // --------------------------------------------
      // Respect manualBreak flag in Firestore — if manualBreak is true, DO NOT perform idle transitions
      // --------------------------------------------
      let agentData = {};
      try {
        const snap = await db.collection('agentStatus').doc(uid).get();
        if (snap && snap.exists) agentData = snap.data() || {};
      } catch (e) {
        // ignore read errors — we default to not assuming manual break
        agentData = {};
      }

      const manualBreak = !!agentData.manualBreak;
      manualBreakActive = manualBreak;
      const breakStartedAt = agentData.breakStartedAt || null; // Firestore Timestamp or null

      if (manualBreak) {
        // Reset lastIdleState so when manual break ends we re-evaluate cleanly
        lastIdleState = false;

        // Check manual break timeout (admin setting stored as manualBreakTimeoutMinutes)
        const timeoutMins = Number(cachedAdminSettings?.manualBreakTimeoutMinutes) || 0;
        if (timeoutMins > 0 && breakStartedAt) {
          let startedMs = null;
          try {
            if (typeof breakStartedAt.toDate === 'function') startedMs = breakStartedAt.toDate().getTime();
            else startedMs = new Date(breakStartedAt).getTime();
          } catch (e) { startedMs = null; }

          if (startedMs) {
            const elapsedMs = Date.now() - startedMs;
            const elapsedMins = Math.floor(elapsedMs / 60000);

            if (elapsedMins >= timeoutMins && !manualBreakNotified.get(uid)) {
              manualBreakNotified.set(uid, true);
              // notify renderer to show persistent modal (renderer should present Remove Break / Cancel)
              if (mainWindow && mainWindow.webContents) {
                try {
                  mainWindow.webContents.send('manual-break-timeout', { uid, elapsedMins, timeoutMins });
                } catch (e) {
                  console.warn('[manual-break-timeout] send failed', e);
                }
              }
            }
          }
        }

        // Do not do idle-driven writes while manual break is active
        return;
      }

      // --------------------------
      // Idle detected (idleLimit>0)
      // --------------------------
      if (shouldForceIdle && !lastIdleState) {
        lastIdleState = true;
        log(systemLocked ? "System lock detected — setting status to break" : "User idle detected — setting status to break");
        await pushIdleStatus(uid, { idleSecs, reason: idleReason });
        return;
      }

      if (!shouldForceIdle && lastIdleState) {
        lastIdleState = false;
        log("Idle cleared — setting status to online");
        await pushActiveStatus(uid, { idleSecs });
        return;
      }

      // No transition -> do nothing (we intentionally avoid extra periodic writes here)

    } catch(e){ console.error("[statusLoop] error", e); }
  }, 3000);
}

function stopAgentStatusLoop() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

function stopAgentStatusWatch() {
  if (agentStatusUnsub) {
    try { agentStatusUnsub(); } catch (e) { log("agentStatus watch cleanup failed", e?.message || e); }
    agentStatusUnsub = null;
  }
}

function startAgentStatusWatch(uid) {
  try {
    stopAgentStatusWatch();
    if (!uid) return;
    const docRef = db.collection('agentStatus').doc(uid);
    agentStatusUnsub = docRef.onSnapshot((snap) => {
      if (!snap.exists) return;
      if (snap.metadata?.hasPendingWrites) return; // skip local echoes
      const data = snap.data() || {};
      const remoteStatus = data.status;
      if (!remoteStatus) return;

      if ((remoteStatus === 'offline' || remoteStatus === 'clocked_out') && (agentClockedIn || isRecordingActive)) {
        log('[agentStatusWatch] remote status is', remoteStatus, '- forcing local stop');
        applyAgentStatus(remoteStatus === 'clocked_out' ? 'clocked_out' : 'offline').catch((err) => {
          console.error('[agentStatusWatch] failed to apply remote status', err?.message || err);
        });
      }
    }, (error) => {
      console.error('[agentStatusWatch] listener error', error?.message || error);
    });
  } catch (e) {
    console.error('[startAgentStatusWatch] failed', e?.message || e);
  }
}

function stopAutoClockConfigWatch() {
  if (autoClockConfigUnsub) {
    try { autoClockConfigUnsub(); } catch (e) { log("autoClockConfig watch cleanup failed", e?.message || e); }
    autoClockConfigUnsub = null;
  }
}

function startAutoClockConfigWatch(uid) {
  try {
    stopAutoClockConfigWatch();
    if (!uid) return;
    const docRef = db.collection('autoClockConfigs').doc(uid);
    autoClockConfigUnsub = docRef.onSnapshot((snap) => {
      autoClockSlots = snap.exists ? (snap.data() || {}) : {};
      lastAutoClockOutTargetKey = null;
    }, (error) => {
      console.error('[autoClockConfigWatch] listener error', error?.message || error);
    });
  } catch (e) {
    console.error('[startAutoClockConfigWatch] failed', e?.message || e);
  }
}

const toScheduleDateKey = (date = new Date()) => {
  const timezone = getOrganizationTimezone();
  return DateTime.fromJSDate(date).setZone(timezone).toFormat('yyyy-MM-dd');
};

const buildDateFromComponents = (dateKey, timeStr, timezone, isOvernight) => {
  if (!dateKey || !timeStr) return null;
  const base = DateTime.fromISO(`${dateKey}T${timeStr}`, { zone: timezone, setZone: true });
  if (!base.isValid) return null;
  const target = isOvernight ? base.plus({ days: 1 }) : base;
  return target.toJSDate();
};

const buildDateFromSlot = (slot, dateKey) => {
  if (!slot?.shiftEndTime) return null;
  const timezone = slot.timezone || getOrganizationTimezone();
  return buildDateFromComponents(dateKey, slot.shiftEndTime, timezone, Boolean(slot.isOvernightShift));
};

const buildDateFromTime = (now, timeStr) => {
  if (!timeStr) return null;
  const timezone = getOrganizationTimezone();
  const dateKey = DateTime.fromJSDate(now).setZone(timezone).toFormat('yyyy-MM-dd');
  return buildDateFromComponents(dateKey, timeStr, timezone, false);
};

function getAutoClockTargetDate(now = new Date()) {
  if (!cachedAdminSettings?.autoClockOutEnabled) return null;
  if (!currentUid || !agentClockedIn) return null;

  if (currentShiftDate) {
    const slot = autoClockSlots?.[currentShiftDate];
    const slotTarget = buildDateFromSlot(slot, currentShiftDate);
    if (slotTarget) return slotTarget;
  }

  if (cachedAdminSettings?.autoClockOutTime) {
    return buildDateFromTime(now, cachedAdminSettings.autoClockOutTime);
  }

  return null;
}

// ---------- AUTO CLOCK-OUT WATCHER ----------
function startAutoClockOutWatcher() {
  try {
    if (autoClockOutInterval) return;
    // check every 60 seconds
    autoClockOutInterval = setInterval(async () => {
      try {
        const target = getAutoClockTargetDate();
        if (!target) return;
        const now = new Date();
        if (now >= target) {
          const key = target.toISOString();
          if (lastAutoClockOutTargetKey === key) return;
          await performAutoClockOut();
          lastAutoClockOutTargetKey = key;
        }
      } catch (e) {
        console.error("[autoClockOutWatcher] error", e);
      }
    }, 60 * 1000);
    log("autoClockOutWatcher started");
  } catch (e) {
    console.error("[startAutoClockOutWatcher] error", e);
  }
}

function stopAutoClockOutWatcher() {
  try {
    if (autoClockOutInterval) {
      clearInterval(autoClockOutInterval);
      autoClockOutInterval = null;
    }
    log("autoClockOutWatcher stopped");
  } catch (e) {
    console.error("[stopAutoClockOutWatcher] error", e);
  }
}

async function performAutoClockOut() {
  try {
    if (!currentUid) return;
    log("[autoClockOut] performing auto clock out for uid:", currentUid);

    // Stop recording if active
    // Force stop even if isRecordingActive is false (to clean up renderer state)
    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});
    if (wasRecording) showRecordingPopup("Recording stopped (auto clock-out)");
    
    // Always send stop command to renderer
    if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid: currentUid });

    // mark offline in agentStatus
    await db.collection('agentStatus').doc(currentUid).set({
      status: 'offline',
      isIdle: false,
      isDesktopConnected: false,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true }).catch(()=>{});

    // inform renderer
    if (mainWindow) mainWindow.webContents.send("auto-clocked-out", { uid: currentUid });

    // ensure renderer clears any locally-stored desktop UID so app won't auto-register on restart
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("clear-desktop-uid");
      }
    } catch(e) { console.warn("[performAutoClockOut] failed to send clear-desktop-uid", e); }

    // optionally: perform any upload logic if you want here (your current Dropbox uploads happen on save)
    // keep currentUid as-is but mark agentClockedIn false
    agentClockedIn = false;
    stopAgentStatusLoop();
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;

  } catch (e) {
    console.error("[performAutoClockOut] error", e);
  }
}

// ---------- IPC ----------
ipcMain.handle("ping", () => "pong");

ipcMain.handle("sync-admin-settings", async (_event, settings) => {
  try {
    applyAdminSettings(settings || {});
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("register-uid", async (_, payload) => {
  try {
    const normalized = typeof payload === "string" ? { uid: payload } : (payload || {});
    const uid = normalized?.uid;
    const desktopToken = normalized?.desktopToken;
    if (!uid) return { success: false, error: "no-uid" };

    if (desktopToken) {
      try {
        if (clientAuth.currentUser && clientAuth.currentUser.uid !== uid) {
          await clientAuth.signOut().catch(() => undefined);
        }
        await clientAuth.signInWithCustomToken(desktopToken);
      } catch (authError) {
        console.error("[register-uid] signInWithCustomToken failed", authError);
        return { success: false, error: "auth-failed" };
      }
    } else if (!clientAuth.currentUser || clientAuth.currentUser.uid !== uid) {
      return { success: false, error: "missing-token" };
    }

    currentUid = uid;
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;

    // fetch and cache displayName for nicer Dropbox folders
    try {
      cachedDisplayName = await fetchDisplayName(uid);
      log("Cached displayName:", cachedDisplayName);
    } catch (e) { cachedDisplayName = uid; }

    // don't assume clocked in until web tells us
    agentClockedIn = false;

    startCommandsWatch(uid);
    startAgentStatusLoop(uid); // loop will only do idle logic if agentClockedIn === true
    startAgentStatusWatch(uid);
    startAutoClockConfigWatch(uid);
    await flushPendingAgentStatuses();

    if (mainWindow) mainWindow.webContents.send("desktop-registered", { uid });
    log("Registered uid:", uid);
    return { success: true };
  } catch(e){
    return { success: false, error: e.message };
  }
});

ipcMain.handle("unregister-uid", async () => {
  try {
    if (commandUnsub) { try { commandUnsub(); } catch(e){} commandUnsub = null; }
    stopAgentStatusLoop();
    stopAgentStatusWatch();
    stopAutoClockConfigWatch();
    pendingAgentStatuses.length = 0;
    if (currentUid) {
      await db.collection("agentStatus").doc(currentUid).set({ isDesktopConnected: false, status: 'offline', lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
    }

    // ensure renderer clears local desktop uid to prevent auto login
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("clear-desktop-uid");
      }
    } catch(e) { console.warn("[unregister-uid] failed to send clear-desktop-uid", e); }

    currentUid = null;
    agentClockedIn = false;
    isRecordingActive = false;
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;
    try { await clientAuth.signOut(); } catch (signOutErr) { console.warn("[unregister-uid] signOut failed", signOutErr?.message || signOutErr); }
    return { success: true };
  } catch(e){
    return { success: false, error: e.message };
  }
});

// New IPC: allow web to tell desktop about agent status changes
async function applyAgentStatus(status) {
  if (!currentUid) {
    throw new Error('no-uid');
  }

  // Accept 'manual_break' from web/renderer when user starts a manual break
  if (status === 'manual_break') {
    agentClockedIn = true;
    await db.collection('agentStatus').doc(currentUid).set({
      status: 'break',
      manualBreak: true,
      breakStartedAt: FieldValue.serverTimestamp(),
      isIdle: false,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true }).catch(()=>{});

    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});

    if (wasRecording) showRecordingPopup('Recording paused (break)');
    if (mainWindow) mainWindow.webContents.send('command-stop-recording', { uid: currentUid });

    manualBreakNotified.delete(currentUid);
    return { success: true };
  }

  if (status === 'clocked_out' || status === 'offline') {
    agentClockedIn = false;
    stopAgentStatusLoop();
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;

    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});

    if (wasRecording) showRecordingPopup('Recording stopped');
    if (mainWindow) mainWindow.webContents.send('command-stop-recording', { uid: currentUid });

    await db.collection('agentStatus').doc(currentUid).set({
      status: 'offline',
      isIdle: false,
      isDesktopConnected: false,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true }).catch(()=>{});
    return { success: true };
  }

  if (status === 'working' || status === 'online') {
    agentClockedIn = true;
    const dateKey = toScheduleDateKey();
    if (currentShiftDate !== dateKey) {
      currentShiftDate = dateKey;
      lastAutoClockOutTargetKey = null;
    }
    startAgentStatusLoop(currentUid);

    const safeSettings = cachedAdminSettings || {};
    const allowRecording = safeSettings.allowRecording !== false;
    const recordingMode = safeSettings.recordingMode || 'auto';

    if (recordingMode === 'auto' && allowRecording) {
      if (!isRecordingActive) {
        isRecordingActive = true;
        await db.collection('agentStatus').doc(currentUid).set({ isRecording: true }, { merge: true }).catch(()=>{});
        showRecordingPopup('Recording started');
        if (mainWindow) mainWindow.webContents.send('command-start-recording', { uid: currentUid });
      } else {
        log('Online signal received, but recording is already active (ignoring)');
      }
    }

    await db.collection('agentStatus').doc(currentUid).set({
      status: 'online',
      isIdle: false,
      isDesktopConnected: true,
      lastUpdate: FieldValue.serverTimestamp(),
      manualBreak: false,
      breakStartedAt: FieldValue.delete()
    }, { merge: true }).catch(()=>{});

    manualBreakNotified.delete(currentUid);
    return { success: true };
  }

  if (status === 'on_break' || status === 'break') {
    agentClockedIn = true;

    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});

    if (wasRecording) showRecordingPopup('Recording paused (break)');
    if (mainWindow) mainWindow.webContents.send('command-stop-recording', { uid: currentUid });

    await db.collection('agentStatus').doc(currentUid).set({
      status: 'break',
      isIdle: true,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true }).catch(()=>{});
    return { success: true };
  }

  return { success: true };
}

async function flushPendingAgentStatuses() {
  if (!currentUid || pendingAgentStatuses.length === 0) return;
  const queued = pendingAgentStatuses.splice(0, pendingAgentStatuses.length);
  for (const status of queued) {
    try {
      await applyAgentStatus(status);
    } catch (err) {
      log('Failed to apply queued agent status', status, err?.message || err);
    }
  }
}

ipcMain.handle("set-agent-status", async (_, status) => {
  try {
    log("set-agent-status received:", status); 
    if (!currentUid) {
      log('Desktop not registered yet. Queuing status:', status);
      pendingAgentStatuses.push(status);
      return { success: true, queued: true };
    }

    return await applyAgentStatus(status);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Desktop-initiated end-break: renderer will handle worklog updates. We try to notify renderer; if renderer not available, clear manualBreak server-side.
ipcMain.handle('end-break-from-desktop', async () => {
  try {
    if (!currentUid) return { success: false, error: 'no-uid' };

    // Try to notify renderer (web) to perform the same end-break flow (update worklog & agentStatus)
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('desktop-request-end-break', { uid: currentUid });
        return { success: true, deliveredToRenderer: true };
      }
    } catch (e) {
      // fallthrough to server-side update
    }

    // Renderer not available — perform minimal safe server-side changes:
    //  - clear manualBreak flag and breakStartedAt
    //  - set agentStatus to online
    await db.collection('agentStatus').doc(currentUid).set({
      status: 'online',
      manualBreak: false,
      breakStartedAt: FieldValue.delete(),
      isIdle: false,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true }).catch(()=>{});

    // Optionally inform renderer if it comes back
    try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('manual-break-cleared-by-desktop', { uid: currentUid }); } catch(e){}

    return { success: true, deliveredToRenderer: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Recording handlers
ipcMain.handle("start-recording", async () => {
  try {
    if (cachedAdminSettings.allowRecording === false) {
      return { success: false, error: "disabled" };
    }
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
    // mark recording active - the renderer should call notify-recording-saved when done
    isRecordingActive = true;
    if (currentUid) {
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
    }
    // show popup if admin enabled notifications
    showRecordingPopup("Recording started");
    log("start-recording: provided sources count:", sources.length);

    // RECORDING QUALITY: determine target width/height based on admin setting
    const quality = String(cachedAdminSettings?.recordingQuality || "720p");
    const mapping = {
      "480p": { width: 640, height: 480, label: "480p" },
      "720p": { width: 1280, height: 720, label: "720p" },
      "1080p": { width: 1920, height: 1080, label: "1080p" }
    };
    const resolution = mapping[quality] || mapping["720p"];

    // Return sources and resolution so renderer can apply proper getUserMedia constraints
    return { success: true, sources: sources.map(s => ({ id: s.id, name: s.name })), resolution };
  } catch (e) {
    console.error("[start-recording] error", e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle("live-stream-get-sources", async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
    const quality = String(cachedAdminSettings?.recordingQuality || "720p");
    const mapping = {
      "480p": { width: 640, height: 480 },
      "720p": { width: 1280, height: 720 },
      "1080p": { width: 1920, height: 1080 }
    };
    const resolution = mapping[quality] || mapping["720p"];
    return {
      success: true,
      sources: sources.map((s) => ({ id: s.id, name: s.name })),
      resolution
    };
  } catch (error) {
    console.error("[live-stream-get-sources] error", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("stop-recording", async () => {
  try {
    // called by renderer when it ends recording explicitly
    isRecordingActive = false;
    if (currentUid) {
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
    }
    showRecordingPopup("Recording stopped");
    log("stop-recording invoked");
    return { success: true };
  } catch (e) {
    console.error("[stop-recording] error", e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle("notify-recording-saved", async (_, fileName, arrayBuffer) => {
  try {
    const buffer = Buffer.from(arrayBuffer);
    const filePath = path.join(RECORDINGS_DIR, fileName);
    fs.writeFileSync(filePath, buffer);
    log("Saved recording to:", filePath);

    if (cachedAdminSettings?.autoUpload && hasDropboxCredentials()) {
      log("uploading to Dropbox:", filePath);
      const safeName = cachedDisplayName ? String(cachedDisplayName).replace(/[\/:*?"<>|]/g, '-') : (currentUid || 'unknown');
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const isoDate = `${yyyy}-${mm}-${dd}`;
      const dropboxPath = `/recordings/${safeName}/${isoDate}/${fileName}`;
      const up = await uploadToDropboxWithPath(filePath, dropboxPath);
      log("upload result:", up);
      if (currentUid) {
        await db.collection("agentStatus").doc(currentUid)
          .set({ lastUpload: FieldValue.serverTimestamp(), lastUploadResult: up.success ? "ok" : "fail" }, { merge: true });
      }
      return { success: true, filePath, uploaded: up };
    }

    return { success: true, filePath };
  } catch(e){
    console.error("[notify-recording-saved] error", e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle("get-idle-time", () => {
  let idleLimit = Number(cachedAdminSettings?.idleTimeout);
  if (isNaN(idleLimit) || idleLimit < 0) idleLimit = 10;
  return {
    idleSecs: powerMonitor.getSystemIdleTime(),
    idleLimit
  };
});

// Expose whether user is currently clocked in (for sign-out confirmation in web)
ipcMain.handle("request-sign-out", async () => {
  try {
    return { success: true, clockedIn: !!agentClockedIn };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Clock out and then unregister (used when web chooses "Clock Out & Sign Out")
ipcMain.handle("clock-out-and-sign-out", async () => {
  try {
    if (currentUid) {
      // perform same actions as manual clock out
      agentClockedIn = false;
      stopAgentStatusLoop();
      
      // ⚡ FIX: Force stop logic
      const wasRecording = isRecordingActive;
      isRecordingActive = false;
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});
      
      if (wasRecording) showRecordingPopup("Recording stopped");
      
      // ALWAYS tell renderer to stop
      if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid: currentUid });

      // mark offline
      await db.collection('agentStatus').doc(currentUid).set({
        status: 'offline',
        isIdle: false,
        isDesktopConnected: false,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true }).catch(()=>{});

      // unregister user on desktop
      if (commandUnsub) { try { commandUnsub(); } catch(e){} commandUnsub = null; }
      stopAgentStatusWatch();
      stopAutoClockConfigWatch();
      currentUid = null;
      agentClockedIn = false;
      isRecordingActive = false;
      currentShiftDate = null;
      lastAutoClockOutTargetKey = null;
      try { await clientAuth.signOut(); } catch (signOutErr) { console.warn("[clock-out-and-sign-out] signOut failed", signOutErr?.message || signOutErr); }

      // ensure renderer clears any locally-stored desktop UID to prevent auto login
      try {
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send("clear-desktop-uid");
        }
      } catch(e) { console.warn("[clock-out-and-sign-out] failed to send clear-desktop-uid", e); }

      // notify renderer
      if (mainWindow) mainWindow.webContents.send("signed-out", { reason: "clocked_out_and_signed_out" });
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("upload-dropbox", async (_, filePath, dropboxPathOverride) => {
  try {
    if (!hasDropboxCredentials()) throw new Error("no-token");
    const fileName = path.basename(filePath || "recording.webm");
    const dropboxPath = dropboxPathOverride || `/manual-uploads/${fileName}`;
    return await uploadToDropboxWithPath(filePath, dropboxPath);
  } catch(e){
    return { success: false, error: e.message };
  }
});

ipcMain.on("minimize-to-tray", () => {
  if (mainWindow) mainWindow.hide();
});

// New IPC handler for set-auto-launch (preload exposes it)
ipcMain.handle("set-auto-launch", async (_, enable) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enable });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auto-install-update", async () => {
  try {
    autoUpdater.quitAndInstall();
    return { success: true };
  } catch (error) {
    emitAutoUpdateStatus("error", { message: error?.message || String(error) });
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("auto-check-updates", async () => {
  try {
    if (isDev) {
      emitAutoUpdateStatus("error", { message: "Auto updates disabled in dev mode" });
      return { success: false, error: "dev-mode" };
    }
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (error) {
    emitAutoUpdateStatus("error", { message: error?.message || String(error) });
    return { success: false, error: error?.message || String(error) };
  }
});

// ---------- DROPBOX TOKEN REFRESH ----------
async function refreshDropboxToken() {
  try {
    if (!cachedDropboxRefreshToken) {
      log("[dropbox] no refresh token available");
      return null;
    }

    const appKey = getDropboxAppKey();
    const appSecret = getDropboxAppSecret();
    if (!appKey || !appSecret) {
      log("[dropbox] missing app key/secret for refresh");
      return null;
    }

    // Request new access token using refresh token
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: cachedDropboxRefreshToken
      })
    });

    const json = await res.json();
    if (!res.ok) {
      log("[dropbox] token refresh failed:", json);
      return null;
    }

    cachedDropboxAccessToken = json.access_token;
    const expiresIn = (json.expires_in || (4 * 60 * 60));
    dropboxTokenExpiry = Date.now() + (expiresIn * 1000);
    log("[dropbox] token refreshed, expires in", json.expires_in, "seconds");

    // Update Firebase with new token if needed
    if (currentUid) {
      await db.collection('agentStatus').doc(currentUid)
        .set({ lastTokenRefresh: FieldValue.serverTimestamp() }, { merge: true })
        .catch(()=>{});
    }

    return cachedDropboxAccessToken;
  } catch (e) {
    log("[dropbox] token refresh error:", e.message);
    return null;
  }
}

// Get valid Dropbox access token, refreshing if needed
async function getValidDropboxToken() {
  try {
    // If we have a cached token and it hasn't expired (or no expiry provided), use it
    if (cachedDropboxAccessToken) {
      if (!dropboxTokenExpiry || Date.now() < dropboxTokenExpiry - 60000) {
        return cachedDropboxAccessToken;
      }
    }

    // Token expired or missing, refresh it
    const newToken = await refreshDropboxToken();
    if (newToken) {
      return newToken;
    }

    // Fallback to admin settings token (might be expired, but try anyway)
    return cachedAdminSettings?.dropboxToken || null;
  } catch (e) {
    log("[dropbox] getValidDropboxToken error:", e.message);
    return cachedAdminSettings?.dropboxToken || null;
  }
}

// Upload to Dropbox with explicit path

async function uploadToDropboxWithPath(filePath, dropboxPath) {
  try {
    const validToken = await getValidDropboxToken();

    if (!validToken) {
      return { success: false, error: "no-valid-token" };
    }

    const content = fs.readFileSync(filePath);
    const arg = { path: dropboxPath, mode: "add", autorename: true };

    const callDropboxUpload = async (token) => {
      const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Dropbox-API-Arg": JSON.stringify(arg),
          "Content-Type": "application/octet-stream"
        },
        body: content
      });

      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (parseErr) {
        parsed = { raw, parseError: parseErr?.message || "invalid-json" };
      }

      return { response, body: parsed };
    };

    let { response, body } = await callDropboxUpload(validToken);

    if (response.status === 401) {
      log("[dropbox] got 401, attempting token refresh");
      const newToken = await refreshDropboxToken();
      if (newToken) {
        ({ response, body } = await callDropboxUpload(newToken));
      }
    }

    if (!response.ok) {
      log("[dropbox] upload failed", response.status, body);
      return { success: false, error: body || { status: response.status } };
    }

    return { success: true, meta: body };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ---------- AUTO UPDATE ----------
function scheduleAutoUpdateCheck() {
  if (isDev) {
    log("autoUpdater skipped in dev mode");
    return;
  }

  const delay = Number(process.env.AUTO_UPDATE_DELAY_MS || 3000);
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      emitAutoUpdateStatus("error", { message: error?.message || String(error) });
    });
  }, isNaN(delay) ? 3000 : delay);
}

// ---------- APP INIT ----------
app.whenReady().then(() => {
  registerSystemLockHandlers();
  createMainWindow();
  createTray();
  buildAppMenu();

  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  scheduleAutoUpdateCheck();
});

app.on("before-quit", () => {
  isQuiting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregister("CommandOrControl+Shift+I");
  globalShortcut.unregister("F12");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});