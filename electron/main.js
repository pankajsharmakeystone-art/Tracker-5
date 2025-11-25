// electron/main.js
// Version: Continuous Recording on Idle Fix
// Changes:
// 1. REMOVED all "Stop Recording" logic from the Idle Detection block. (Recording now continues during idle).
// 2. ADDED a check (!isRecordingActive) in the "Return from Idle" block. (Prevents "Already Active" error if recording never stopped).
// 3. ADDED a check (!isRecordingActive) in the Manual "End Break" handler. (Safety check to prevent double-start errors).

const { app, BrowserWindow, ipcMain, desktopCapturer, powerMonitor, Tray, Menu, nativeImage, screen, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fetch = require("node-fetch");
const electronLog = require("electron-log");

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

// ---------- FIREBASE ADMIN ----------
const admin = require("firebase-admin");
let serviceAccount = null;
let firebaseKeyPath = process.env.FIREBASE_KEY_PATH;
try {
  if (firebaseKeyPath && fs.existsSync(firebaseKeyPath)) {
    const rawData = fs.readFileSync(firebaseKeyPath, "utf8");
    serviceAccount = JSON.parse(rawData);
    log("Loaded Firebase key from FIREBASE_KEY_PATH:", firebaseKeyPath);
  } else if (fs.existsSync(path.join(__dirname, "firebase-key.json"))) {
    const rawData = fs.readFileSync(path.join(__dirname, "firebase-key.json"), "utf8");
    serviceAccount = JSON.parse(rawData);
    log("Loaded Firebase key from local firebase-key.json");
  } else {
    throw new Error("No Firebase service account key found. Set FIREBASE_KEY_PATH or place firebase-key.json in electron/");
  }
  
  // Validate service account has required fields
  if (!serviceAccount || typeof serviceAccount !== "object") {
    throw new Error("Firebase key file must contain a valid JSON object");
  }
  if (!serviceAccount.project_id) {
    throw new Error("Firebase key file missing required 'project_id' field");
  }
  if (!serviceAccount.private_key) {
    throw new Error("Firebase key file missing required 'private_key' field");
  }
  if (!serviceAccount.client_email) {
    throw new Error("Firebase key file missing required 'client_email' field");
  }
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  log("Firebase Admin SDK initialized successfully");
} catch (e) {
  log("FATAL: Could not initialize Firebase Admin SDK:", e.message);
  if (e.stack) log(e.stack);
  dialog.showErrorBoxSync(
    "Firebase Initialization Error",
    `Could not initialize Firebase Admin SDK:\n\n${e.message}\n\nPlease check:\n1. firebase-key.json exists in electron/ folder\n2. The file contains valid service account JSON\n3. Required fields: project_id, private_key, client_email`
  );
  process.exit(1);
}

let db;
try {
  db = admin.firestore();
} catch (e) {
  log("FATAL: Could not get Firestore instance:", e.message);
  dialog.showErrorBoxSync("Firestore Error", `Could not initialize Firestore: ${e.message}`);
  process.exit(1);
}

// ---------- CONFIG ----------
const VERCEL_URL = "https://tracker-5.vercel.app/";
const RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Path to the uploaded icon you asked to use for the popup
const POPUP_ICON_PATH = "/mnt/data/a35a616b-074d-4238-a09e-5dcb70efb649.png"; 

// ---------- GLOBALS ----------
let mainWindow = null;
let lockWindow = null;
let tray = null;
let cachedAdminSettings = {};
let currentUid = null;
let commandUnsub = null;
let adminSettingsUnsub = null;
let statusInterval = null;
let lastIdleState = false; // track previous idle state
let agentClockedIn = false; // only monitor idle when true
let isRecordingActive = false; // track recording
let popupWindow = null; // reference to the transient popup
let cachedDisplayName = null; // cached user displayName (filled on register)

let autoClockOutInterval = null;
let lastAutoClockOutDate = null; // YYYY-MM-DD to prevent multiple auto clockouts per day

// Dropbox token management
let cachedDropboxAccessToken = null;
let cachedDropboxRefreshToken = null;
let dropboxTokenExpiry = null;

// track manual-break timeout notifications per uid to avoid repeat spam
const manualBreakNotified = new Map();

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
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------- LOCK WINDOW ----------
function createLockWindow() {
  if (lockWindow) return;

  lockWindow = new BrowserWindow({
    width: 600,
    height: 700,
    parent: mainWindow || null,
    modal: true,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  lockWindow.loadURL(`${VERCEL_URL}`);
  lockWindow.once("ready-to-show", () => lockWindow.show());
  lockWindow.on("closed", () => { lockWindow = null; });
}

function removeLockWindow() {
  try {
    if (lockWindow) {
      lockWindow.close();
      lockWindow = null;
    }
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  } catch(e) {}
}

// ---------- TRAY ----------
function createTray() {
  try {
    const iconPath = path.join(__dirname, "icon.png");
    const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
    tray = new Tray(image || undefined);
    const menu = Menu.buildFromTemplate([
      { label: "Open App", click: () => { if (mainWindow) mainWindow.show(); } },
      { label: "Quit", click: () => app.quit() }
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

// ---------- ADMIN SETTINGS WATCH ----------
function startAdminSettingsWatch() {
  if (adminSettingsUnsub) return;
  const ref = db.collection("adminSettings").doc("global");
  adminSettingsUnsub = ref.onSnapshot(doc => {
    if (!doc.exists) {
      cachedAdminSettings = {};
      return;
    }
    cachedAdminSettings = doc.data() || {};
    log("adminSettings updated:", cachedAdminSettings);

    // Cache Dropbox tokens for refresh logic
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

    // handle login lock
    if (cachedAdminSettings.requireLoginOnBoot && !currentUid) {
      if (!lockWindow) createLockWindow();
      if (mainWindow) mainWindow.hide();
    }

    if (mainWindow) mainWindow.webContents.send("settings-updated", cachedAdminSettings);

    // Start/stop autoClockOut watcher depending on setting
    if (cachedAdminSettings?.autoClockOutEnabled) {
      startAutoClockOutWatcher();
    } else {
      stopAutoClockOutWatcher();
    }
  });
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
      if (currentUid) await db.collection('agentStatus').doc(currentUid).set({ isRecording: true, lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
      showRecordingPopup("Recording started by admin");
      await db.collection("desktopCommands").doc(uid).update({ startRecording: false }).catch(()=>{});
    }

    if (cmd.stopRecording) {
      log("command stopRecording received");
      if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid });
      isRecordingActive = false;
      if (currentUid) await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
      showRecordingPopup("Recording stopped by admin");
      await db.collection("desktopCommands").doc(uid).update({ stopRecording: false }).catch(()=>{});
    }

    if (cmd.forceBreak) {
      log("force break cmd");
      await db.collection('agentStatus').doc(uid)
        .set({ status: "break", lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
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
      await db.collection("desktopCommands").doc(uid).update({ setAutoLaunch: admin.firestore.FieldValue.delete() }).catch(()=>{});
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
          lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
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
      let isIdle = false;

      // idleTimeout = 0 → completely disable idle detection
      if (idleLimit > 0) {
        isIdle = idleSecs >= idleLimit;
      } else {
        isIdle = false; // idle tracking turned off
      }

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
      if (isIdle && !lastIdleState) {
        lastIdleState = true;
        log("User idle detected — setting status to break");
        await db.collection("agentStatus").doc(uid)
          .set({
            status: "break",
            isIdle: true,
            idleSecs,
            lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
            appVersion: app.getVersion(),
            platform: process.platform,
            machineName: os.hostname(),
            isDesktopConnected: true
          }, { merge: true }).catch(()=>{});
          
        // ⚡ FIX: Removed all "Stop Recording" logic here. 
        // Now, when user goes idle, recording continues without interruption.
        
        return;
      }

      if (!isIdle && lastIdleState) {
        lastIdleState = false;
        log("User returned from idle — setting status to online");
        await db.collection("agentStatus").doc(uid)
          .set({
            status: "online",
            isIdle: false,
            idleSecs,
            lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
            appVersion: app.getVersion(),
            platform: process.platform,
            machineName: os.hostname(),
            isDesktopConnected: true
          }, { merge: true }).catch(()=>{});
        
        // resume recording automatically if admin configured auto recordingMode and allowRecording
        if (cachedAdminSettings?.recordingMode === 'auto' && cachedAdminSettings?.allowRecording) {
          
          // ⚡ FIX: Only restart if it actually stopped! 
          // Since we now keep recording during idle, isRecordingActive will usually be true.
          // This prevents the "Already Active" error when returning from idle.
          if (!isRecordingActive) {
              isRecordingActive = true;
              await db.collection('agentStatus').doc(uid).set({ isRecording: true, lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
              showRecordingPopup("Recording resumed");
              
              if (mainWindow && mainWindow.webContents) {
                 mainWindow.webContents.send("command-start-recording", { uid });
              }
          } else {
              log("Returned from idle. Recording was already active, continuing.");
          }
        }
        return;
      }

      // No transition -> do nothing (we intentionally avoid extra periodic writes here)

    } catch(e){ console.error("[statusLoop] error", e); }
  }, 3000);
}

function stopAgentStatusLoop() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

// ---------- AUTO CLOCK-OUT WATCHER ----------
function startAutoClockOutWatcher() {
  try {
    if (autoClockOutInterval) return;
    // check every 60 seconds
    autoClockOutInterval = setInterval(async () => {
      try {
        if (!cachedAdminSettings?.autoClockOutEnabled) return;
        if (!cachedAdminSettings?.autoClockOutTime) return;
        if (!currentUid) return;
        if (!agentClockedIn) return;

        // parse admin time "HH:mm" (24h)
        const t = String(cachedAdminSettings.autoClockOutTime || '').trim();
        if (!/^\d{1,2}:\d{2}$/.test(t)) return;
        const parts = t.split(':');
        const hr = Number(parts[0]);
        const min = Number(parts[1]);
        if (isNaN(hr) || isNaN(min)) return;

        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr, min, 0, 0);

        // allow trigger if now >= target
        if (now >= target) {
          const todayStr = now.toISOString().split('T')[0];
          if (lastAutoClockOutDate === todayStr) {
            // already auto clocked out today
            return;
          }
          // perform auto clock out
          await performAutoClockOut();
          lastAutoClockOutDate = todayStr;
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
      lastUpdate: admin.firestore.FieldValue.serverTimestamp()
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

  } catch (e) {
    console.error("[performAutoClockOut] error", e);
  }
}

// ---------- IPC ----------
ipcMain.handle("ping", () => "pong");

ipcMain.handle("register-uid", async (_, uid) => {
  try {
    if (!uid) return { success: false, error: "no-uid" };
    currentUid = uid;

    // fetch and cache displayName for nicer Dropbox folders
    try {
      cachedDisplayName = await fetchDisplayName(uid);
      log("Cached displayName:", cachedDisplayName);
    } catch (e) { cachedDisplayName = uid; }

    // don't assume clocked in until web tells us
    agentClockedIn = false;

    startAdminSettingsWatch();
    startCommandsWatch(uid);
    startAgentStatusLoop(uid); // loop will only do idle logic if agentClockedIn === true

    removeLockWindow();

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
    if (adminSettingsUnsub) { try { adminSettingsUnsub(); } catch(e){} adminSettingsUnsub = null; }
    stopAgentStatusLoop();
    if (currentUid) {
      await db.collection("agentStatus").doc(currentUid).set({ isDesktopConnected: false, status: 'offline', lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
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
    return { success: true };
  } catch(e){
    return { success: false, error: e.message };
  }
});

// New IPC: allow web to tell desktop about agent status changes
ipcMain.handle("set-agent-status", async (_, status) => {
  try {
    log("set-agent-status received:", status); 
    if (!currentUid) return { success: false, error: 'no-uid' };

    // Accept 'manual_break' from web/renderer when user starts a manual break
    if (status === 'manual_break') {
      agentClockedIn = true;
      // mark as break and set manualBreak flag — web will also update worklog
      await db.collection('agentStatus').doc(currentUid).set({
        status: 'break',
        manualBreak: true,
        breakStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        isIdle: false,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(()=>{});

      // Force stop logic for MANUAL break (as requested)
      const wasRecording = isRecordingActive;
      isRecordingActive = false;
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});
      
      if (wasRecording) showRecordingPopup("Recording paused (break)");
      
      // ALWAYS tell renderer to stop
      if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid: currentUid });

      // reset manual-break notified bucket
      manualBreakNotified.delete(currentUid);
      return { success: true };
    }

    if (status === 'clocked_out' || status === 'offline') {
      // stop idle monitoring and mark offline
      agentClockedIn = false;
      stopAgentStatusLoop();
      
      // Force stop logic
      const wasRecording = isRecordingActive;
      isRecordingActive = false;
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});
      
      if (wasRecording) showRecordingPopup("Recording stopped");
      
      // ALWAYS tell renderer to stop
      if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid: currentUid });

      await db.collection('agentStatus').doc(currentUid).set({
        status: 'offline',
        isIdle: false,
        isDesktopConnected: false,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(()=>{});
      return { success: true };
    }

    // Accept BOTH 'working' AND 'online' as triggers to resume recording
    if (status === 'working' || status === 'online') {
      // resume monitoring
      agentClockedIn = true;
      startAgentStatusLoop(currentUid);
      
      // auto-start recording if allowed and mode=auto
      const safeSettings = cachedAdminSettings || {};
      // Default to true if allowRecording is not explicitly false
      const allowRecording = safeSettings.allowRecording !== false;
      const recordingMode = safeSettings.recordingMode || 'auto';
      
      if (recordingMode === 'auto' && allowRecording) {
        
        // ⚡ FIX: Check if ALREADY active to prevent "Already Active" error
        if (!isRecordingActive) {
            isRecordingActive = true;
            await db.collection('agentStatus').doc(currentUid).set({ isRecording: true }, { merge: true }).catch(()=>{});
            showRecordingPopup("Recording started");
            // notify renderer to start recording
            if (mainWindow) mainWindow.webContents.send("command-start-recording", { uid: currentUid });
        } else {
            log("Online signal received, but recording is already active (ignoring)");
        }
      }
      await db.collection('agentStatus').doc(currentUid).set({
        status: 'online',
        isIdle: false,
        isDesktopConnected: true,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
        // clear manualBreak fields if present
        manualBreak: false,
        breakStartedAt: admin.firestore.FieldValue.delete()
      }, { merge: true }).catch(()=>{});

      // Clear manualBreak notified flag when user comes online
      manualBreakNotified.delete(currentUid);
      return { success: true };
    }

    if (status === 'on_break' || status === 'break') {
      // set break state; keep agentClockedIn true
      agentClockedIn = true;
      
      // Force stop logic
      const wasRecording = isRecordingActive;
      isRecordingActive = false;
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(()=>{});
      
      if (wasRecording) showRecordingPopup("Recording paused (break)");
      
      // ALWAYS tell renderer to stop
      if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid: currentUid });

      // Do not force manualBreak flags — web will set manualBreak when it's a manual break.
      await db.collection('agentStatus').doc(currentUid).set({
        status: 'break',
        isIdle: true,
        lastUpdate: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(()=>{});
      return { success: true };
    }

    return { success: true };
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
      breakStartedAt: admin.firestore.FieldValue.delete(),
      isIdle: false,
      lastUpdate: admin.firestore.FieldValue.serverTimestamp()
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
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: true, lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
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
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }).catch(()=>{});
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
          .set({ lastUpload: admin.firestore.FieldValue.serverTimestamp(), lastUploadResult: up.success ? "ok" : "fail" }, { merge: true });
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
        lastUpdate: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(()=>{});

      // unregister user on desktop
      if (commandUnsub) { try { commandUnsub(); } catch(e){} commandUnsub = null; }
      if (adminSettingsUnsub) { try { adminSettingsUnsub(); } catch(e){} adminSettingsUnsub = null; }
      currentUid = null;
      agentClockedIn = false;
      isRecordingActive = false;

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

      // Auto-update IPC
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

    // Persist new short-lived token so other desktops get the update
    try {
      await db.collection("adminSettings").doc("global").set({
        dropboxAccessToken: cachedDropboxAccessToken,
        dropboxTokenExpiry: new Date(dropboxTokenExpiry).toISOString()
      }, { merge: true });
    } catch (persistErr) {
      log("[dropbox] failed to persist refreshed token:", persistErr.message);
    }

    // Update Firebase with new token if needed
    if (currentUid) {
      await db.collection('agentStatus').doc(currentUid)
        .set({ lastTokenRefresh: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
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
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${validToken}`,
        "Dropbox-API-Arg": JSON.stringify(arg),
        "Content-Type": "application/octet-stream"
      },
      body: content
    });
    const json = await res.json();
    
    // If 401 (unauthorized), token expired, try refreshing
    if (res.status === 401) {
      log("[dropbox] got 401, attempting token refresh");
      const newToken = await refreshDropboxToken();
      if (newToken) {
        // Retry with new token
        const retryRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${newToken}`,
            "Dropbox-API-Arg": JSON.stringify(arg),
            "Content-Type": "application/octet-stream"
          },
          body: content
        });
        const retryJson = await retryRes.json();
        if (!retryRes.ok) return { success: false, error: retryJson };
        return { success: true, meta: retryJson };
      }
    }

    if (!res.ok) return { success: false, error: json };
    return { success: true, meta: json };
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
  createMainWindow();
  createTray();
  buildAppMenu();
  startAdminSettingsWatch();

  if (cachedAdminSettings?.requireLoginOnBoot) {
    createLockWindow();
  } else {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  scheduleAutoUpdateCheck();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});