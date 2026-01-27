// electron/main.js
// Version: Continuous Recording on Idle Fix
// Changes:
// 1. REMOVED all "Stop Recording" logic from the Idle Detection block. (Recording now continues during idle).
// 2. ADDED a check (!isRecordingActive) in the "Return from Idle" block. (Prevents "Already Active" error if recording never stopped).
// 3. ADDED a check (!isRecordingActive) in the Manual "End Break" handler. (Safety check to prevent double-start errors).

const { app, BrowserWindow, ipcMain, desktopCapturer, powerMonitor, Tray, Menu, nativeImage, screen, dialog, globalShortcut, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fetch = require("node-fetch");
const electronLog = require("electron-log");
const { DateTime } = require("luxon");
const { google } = require("googleapis");
const fixWebmDuration = require("fix-webm-duration");
const crypto = require("crypto");
// ts-ebml for lightweight WebM duration fix
const { Decoder, Encoder, Reader, tools } = require("ts-ebml");

// FFmpeg for robust video repair (fallback)
const ffmpegStatic = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);

// Fix WebM duration using ts-ebml (lightweight, pure JavaScript)
// This is the PRIMARY method - fast and doesn't require external processes
async function fixWebmDurationWithTsEbml(inputBuffer) {
  try {
    if (!inputBuffer || inputBuffer.length === 0) {
      return { buffer: inputBuffer, fixed: false, method: 'none' };
    }

    const decoder = new Decoder();
    const reader = new Reader();

    // Connect decoder output to reader
    reader.logging = false;
    reader.drop_default_duration = false;

    // Convert Buffer to ArrayBuffer for ts-ebml
    const arrayBuffer = inputBuffer.buffer.slice(
      inputBuffer.byteOffset,
      inputBuffer.byteOffset + inputBuffer.byteLength
    );

    // Decode the EBML elements and feed to reader
    const elms = decoder.decode(arrayBuffer);
    elms.forEach((elm) => reader.read(elm));
    reader.stop();

    // Check if we have the necessary data
    if (!reader.metadatas || reader.metadatas.length === 0) {
      log('[ts-ebml] No metadata found in WebM file');
      return { buffer: inputBuffer, fixed: false, method: 'no-metadata' };
    }

    // Get the refined metadata with duration
    const refinedMetadataBuf = tools.makeMetadataSeekable(
      reader.metadatas,
      reader.duration,
      reader.cues
    );

    // Get the body (video data after the header)
    const body = arrayBuffer.slice(reader.metadataSize);

    // Combine refined metadata with body
    const result = new Uint8Array(refinedMetadataBuf.byteLength + body.byteLength);
    result.set(new Uint8Array(refinedMetadataBuf), 0);
    result.set(new Uint8Array(body), refinedMetadataBuf.byteLength);

    const fixedBuffer = Buffer.from(result);
    log('[ts-ebml] Duration fix success. Original:', inputBuffer.length, 'Fixed:', fixedBuffer.length, 'Duration:', reader.duration);

    return { buffer: fixedBuffer, fixed: true, method: 'ts-ebml' };
  } catch (err) {
    log('[ts-ebml] Duration fix failed:', err?.message || err);
    return { buffer: inputBuffer, fixed: false, method: 'failed', error: err?.message };
  }
}

// auto-updater
const { autoUpdater } = require("electron-updater");

const isDev = process.env.ELECTRON_DEV === 'true' || process.env.NODE_ENV === 'development';
const APP_USER_MODEL_ID = 'com.trackerfive.desktop';
// Online-only force logout: ignore pending force-logout commands/requests older than this TTL.
const FORCE_LOGOUT_TTL_MS = 5 * 1000;
const RECONNECT_TTL_MS = 60 * 1000;

electronLog.initialize?.();
if (electronLog?.transports?.file) {
  electronLog.transports.file.level = "info";
}
autoUpdater.logger = electronLog;
autoUpdater.autoDownload = true;
app.setAppUserModelId(APP_USER_MODEL_ID);

// SINGLE INSTANCE LOCK
// Prevent multiple instances from running to avoid duplicate logs and recording conflicts
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log("Another instance is already running. Quitting...");
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Focus existing window if user tries to run a second instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------- HELPER FUNCTIONS ----------
function log(...args) { console.log("[electron]", ...args); }

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
require("firebase/compat/database");

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

// Robust WebM repair using FFmpeg
// MediaRecorder WebM files lack duration in header - this fixes that by remuxing
// Returns: { buffer: Buffer, repaired: boolean }
async function repairWebmWithFfmpeg(inputBuffer) {
  return new Promise((resolve, reject) => {
    try {
      if (!inputBuffer || inputBuffer.length === 0) {
        return resolve({ buffer: inputBuffer, repaired: false });
      }

      const tempId = crypto.randomBytes(8).toString('hex');
      const inputPath = path.join(os.tmpdir(), `temp_fix_${tempId}.webm`);
      const mkvPath = path.join(os.tmpdir(), `temp_mkv_${tempId}.mkv`);
      const outputPath = path.join(os.tmpdir(), `temp_fixed_${tempId}.webm`);

      fs.writeFileSync(inputPath, inputBuffer);

      // Step 1: Remux to MKV (Matroska properly calculates duration during muxing)
      ffmpeg(inputPath)
        .inputOptions(['-fflags +genpts+igndts', '-err_detect ignore_err'])
        .outputOptions([
          '-c copy',
          '-avoid_negative_ts make_zero'
        ])
        .output(mkvPath)
        .on('stderr', (stderrLine) => {
          if (stderrLine && (stderrLine.includes('Error') || stderrLine.includes('Duration'))) {
            log('[ffmpeg] step1:', stderrLine);
          }
        })
        .on('end', () => {
          // Step 2: Remux back to WebM (now with proper duration)
          ffmpeg(mkvPath)
            .outputOptions([
              '-c copy',
              '-f webm'
            ])
            .output(outputPath)
            .on('stderr', (stderrLine) => {
              if (stderrLine && (stderrLine.includes('Error') || stderrLine.includes('Duration'))) {
                log('[ffmpeg] step2:', stderrLine);
              }
            })
            .on('end', () => {
              try {
                if (fs.existsSync(outputPath)) {
                  const fixedBuf = fs.readFileSync(outputPath);
                  try { fs.unlinkSync(inputPath); } catch (_) { }
                  try { fs.unlinkSync(mkvPath); } catch (_) { }
                  try { fs.unlinkSync(outputPath); } catch (_) { }
                  log('[ffmpeg] repair complete - fixed size:', fixedBuf.length);
                  resolve({ buffer: fixedBuf, repaired: true });
                } else {
                  try { fs.unlinkSync(inputPath); } catch (_) { }
                  try { fs.unlinkSync(mkvPath); } catch (_) { }
                  log('[ffmpeg] output missing, using original');
                  resolve({ buffer: inputBuffer, repaired: false });
                }
              } catch (e) {
                reject(e);
              }
            })
            .on('error', (err) => {
              log('[ffmpeg] step2 error:', err.message);
              try { fs.unlinkSync(inputPath); } catch (_) { }
              try { fs.unlinkSync(mkvPath); } catch (_) { }
              try { fs.unlinkSync(outputPath); } catch (_) { }
              // Return original buffer on step2 failure
              resolve({ buffer: inputBuffer, repaired: false });
            })
            .run();
        })
        .on('error', (err) => {
          log('[ffmpeg] step1 error:', err.message);
          try { fs.unlinkSync(inputPath); } catch (_) { }
          try { fs.unlinkSync(mkvPath); } catch (_) { }
          // Return original buffer on step1 failure
          resolve({ buffer: inputBuffer, repaired: false });
        })
        .run();
    } catch (err) {
      reject(err);
    }
  });
}

const firebaseConfig = {
  apiKey: envOr("FIREBASE_API_KEY", "VITE_FIREBASE_API_KEY"),
  authDomain: envOr("FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: envOr("FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID"),
  databaseURL: envOr("FIREBASE_DATABASE_URL", "VITE_FIREBASE_DATABASE_URL"),
  storageBucket: envOr("FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: envOr("FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: envOr("FIREBASE_APP_ID", "VITE_FIREBASE_APP_ID")
};

const missingFirebaseKeys = Object.entries(firebaseConfig)
  .filter(([key, value]) => key !== 'databaseURL' && !value)
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
const rtdb = firebase.database();
const RTDB_SERVER_TIMESTAMP = firebase.database.ServerValue.TIMESTAMP;
const FieldValue = firebase.firestore.FieldValue;
const Timestamp = firebase.firestore.Timestamp;
const DEFAULT_ORGANIZATION_TIMEZONE = "Asia/Kolkata";

// ---------- CONFIG ----------
const RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Temp folder for in-progress recordings (incremental disk writes)
const TEMP_RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings_temp");
if (!fs.existsSync(TEMP_RECORDINGS_DIR)) fs.mkdirSync(TEMP_RECORDINGS_DIR, { recursive: true });

// Purge stale recordings early during startup to avoid uploading old files from prior sessions
purgeOldRecordings();

// Cleanup helper: delete stale recordings to prevent future re-uploads
function purgeOldRecordings(maxAgeHours = 24) {
  try {
    const entries = fs.readdirSync(RECORDINGS_DIR);
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    entries.forEach((name) => {
      const full = path.join(RECORDINGS_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          log("[recordings] purged stale file", name);
        }
      } catch (err) {
        log("[recordings] purge check failed", err?.message || err);
      }
    });
  } catch (err) {
    log("[recordings] purge failed", err?.message || err);
  }
}

const UPLOAD_MANIFEST_PATH = path.join(app.getPath("userData"), "uploaded-recordings.json");

// Upload manifest v2: tracks per-target success to prevent duplicate uploads and allow retry on next login.
// Backward compatible with the older array-of-filenames format.
let uploadManifest = { version: 2, files: {} };

function loadUploadedManifest() {
  try {
    if (!fs.existsSync(UPLOAD_MANIFEST_PATH)) return;
    const raw = fs.readFileSync(UPLOAD_MANIFEST_PATH, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);

    // Legacy format: ["file1.webm", ...]
    if (Array.isArray(parsed)) {
      uploadManifest = {
        version: 2,
        files: Object.fromEntries(
          parsed
            .filter((x) => typeof x === "string" && x)
            .map((name) => [name, { completed: true, uploadedTargets: { dropbox: true, googleSheets: true }, migratedFromLegacy: true }])
        )
      };
      return;
    }

    // v2 format
    if (parsed && typeof parsed === "object") {
      const files = parsed.files && typeof parsed.files === "object" ? parsed.files : {};
      uploadManifest = {
        version: 2,
        files
      };
    }
  } catch (err) {
    log("[uploads] failed to load manifest", err?.message || err);
    uploadManifest = { version: 2, files: {} };
  }
}

function persistUploadedManifest() {
  try {
    fs.writeFileSync(UPLOAD_MANIFEST_PATH, JSON.stringify(uploadManifest), "utf8");
  } catch (err) {
    log("[uploads] failed to persist manifest", err?.message || err);
  }
}

function getManifestEntry(fileName) {
  if (!fileName) return null;
  return uploadManifest?.files?.[fileName] || null;
}

function upsertManifestEntry(fileName, patch = {}) {
  if (!fileName) return;
  if (!uploadManifest || typeof uploadManifest !== "object") uploadManifest = { version: 2, files: {} };
  if (!uploadManifest.files || typeof uploadManifest.files !== "object") uploadManifest.files = {};
  const existing = uploadManifest.files[fileName] && typeof uploadManifest.files[fileName] === "object"
    ? uploadManifest.files[fileName]
    : {};
  uploadManifest.files[fileName] = { ...existing, ...patch };
  persistUploadedManifest();
}

function setTargetUploadResult(fileName, target, result = {}) {
  if (!fileName || !target) return;
  const existing = getManifestEntry(fileName) || {};
  const uploadedTargets = existing.uploadedTargets && typeof existing.uploadedTargets === "object" ? existing.uploadedTargets : {};
  const lastErrors = existing.lastErrors && typeof existing.lastErrors === "object" ? existing.lastErrors : {};

  if (result.success) {
    uploadedTargets[target] = true;
    delete lastErrors[target];
  } else {
    uploadedTargets[target] = false;
    lastErrors[target] = String(result.error || result.reason || "upload-failed");
  }

  upsertManifestEntry(fileName, {
    uploadedTargets,
    lastErrors,
    lastAttemptAt: new Date().toISOString()
  });
}

function isTargetUploaded(fileName, target) {
  const entry = getManifestEntry(fileName);
  if (!entry) return false;
  // Check individual target status - don't rely on completed flag alone
  // because 'completed' was set prematurely when only some targets succeeded
  const uploadedTargets = entry.uploadedTargets || {};
  if (uploadedTargets[target] === true) return true;
  // Fallback: if completed is true AND we have no explicit false for this target,
  // assume it was uploaded before we started tracking per-target status
  if (entry.completed === true && uploadedTargets[target] !== false) return true;
  return false;
}

function markRecordingCompleted(fileName) {
  upsertManifestEntry(fileName, {
    completed: true,
    completedAt: new Date().toISOString()
  });
}

function isRecordingCompleted(fileName) {
  const entry = getManifestEntry(fileName);
  return Boolean(entry?.completed);
}

loadUploadedManifest();

// ---------- RECORDING LOGS (Firestore) ----------
// Logs upload events to Firestore so admins/managers can see upload status
async function logRecordingEvent(eventData = {}) {
  try {
    const authed = await ensureDesktopAuth();
    if (!authed) {
      log('[recordingLogs] auth missing, skipping log');
      return null;
    }

    const payload = {
      userId: eventData.userId || currentUid || null,
      userName: eventData.userName || cachedDisplayName || null,
      teamId: eventData.teamId || null,
      fileName: eventData.fileName || null,
      status: eventData.status || 'unknown', // 'success' | 'failed' | 'pending'
      uploadTarget: eventData.uploadTarget || null, // 'dropbox' | 'googleSheets' | 'http'
      machineName: os.hostname() || null,
      fileSize: eventData.fileSize || null,
      durationMs: eventData.durationMs || null,
      downloadUrl: eventData.downloadUrl || null,
      error: eventData.error || null,
      retryCount: eventData.retryCount || 0,
      stopReason: eventData.stopReason || null, // 'lock-screen' | 'manual_break' | 'clocked_out' | 'suspend' | 'shutdown' | etc.
      createdAt: eventData.createdAt || FieldValue.serverTimestamp(),
      uploadedAt: eventData.status === 'success' ? FieldValue.serverTimestamp() : null,
      loggedAt: FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('recordingLogs').add(payload);
    log('[recordingLogs] logged event:', payload.status, payload.fileName);
    return docRef.id;
  } catch (err) {
    log('[recordingLogs] failed to log event:', err?.message || err);
    return null;
  }
}

// Update an existing recording log entry (used for retry status updates)
async function updateRecordingLog(logId, updates = {}) {
  try {
    if (!logId) return false;
    const authed = await ensureDesktopAuth();
    if (!authed) return false;

    await db.collection('recordingLogs').doc(logId).update({
      ...updates,
      lastUpdatedAt: FieldValue.serverTimestamp()
    });
    log('[recordingLogs] updated log:', logId, updates.status || '');
    return true;
  } catch (err) {
    log('[recordingLogs] failed to update log:', err?.message || err);
    return false;
  }
}

// Retry uploading a specific recording file by fileName
// Returns { success, error } - error 'file-not-found' if file was deleted
async function retrySpecificRecordingUpload(fileName, logId = null) {
  if (!fileName) return { success: false, error: 'missing-filename' };

  if (activeUploads.has(fileName)) {
    log(`[retry] Skip manual retry for ${fileName} - upload already in progress`);
    return { success: false, error: 'already-uploading' };
  }
  activeUploads.add(fileName);

  const filePath = path.join(RECORDINGS_DIR, fileName);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    log('[retry] File not found:', filePath);
    if (logId) {
      await updateRecordingLog(logId, {
        status: 'failed',
        error: 'file-not-found',
        retryAttemptedAt: FieldValue.serverTimestamp()
      });
    }
    return { success: false, error: 'file-not-found' };
  }

  try {
    const stat = fs.statSync(filePath);
    const safeName = String(cachedDisplayName || currentUid || 'unknown').replace(/[\\/:*?"<>|]/g, '-');
    const isoDate = getIsoDateFromMs(stat.mtimeMs);
    const isoTime = getIsoTimeFromMs(stat.mtimeMs);
    const googleDriveFileName = `${safeName}-${isoDate}-${isoTime}-${fileName}`.replace(/[\\/:*?"<>|]/g, '-');

    const enabledTargets = [];
    if (shouldUploadToDropbox()) enabledTargets.push('dropbox');
    if (shouldUploadToGoogleSheets()) enabledTargets.push('googleSheets');
    if (shouldUploadToHttp()) enabledTargets.push('http');

    if (enabledTargets.length === 0) {
      return { success: false, error: 'no-upload-targets-enabled' };
    }

    const uploadResults = [];

    if (enabledTargets.includes('dropbox')) {
      const dropboxPath = `/recordings/${safeName}/${isoDate}/${isoTime}-${fileName}`;
      log("[retry] uploading to Dropbox:", dropboxPath);
      const dropboxResult = await uploadToDropboxWithPath(filePath, dropboxPath);
      uploadResults.push({ target: 'dropbox', path: dropboxPath, ...dropboxResult });
    }

    if (enabledTargets.includes('googleSheets')) {
      log("[retry] uploading to Google Drive/Sheets:", filePath);
      const googleResult = await uploadRecordingToGoogleTargets({
        filePath,
        fileName,
        safeName,
        isoDate,
        googleFileName: googleDriveFileName
      });
      uploadResults.push({ target: 'googleSheets', ...googleResult });
    }

    if (enabledTargets.includes('http')) {
      const httpResult = await uploadToHttpTarget({ filePath, fileName, safeName, isoDate, isoTime });
      uploadResults.push({ target: 'http', ...httpResult });
    }

    const allSucceeded = uploadResults.every(r => r.success);
    const anySucceeded = uploadResults.some(r => r.success);

    // Update the log entry with retry result
    if (logId) {
      const newStatus = allSucceeded ? 'success' : 'failed';
      const downloadUrl = uploadResults.find(r => r.success && r.meta?.webViewLink)?.meta?.webViewLink || null;
      await updateRecordingLog(logId, {
        status: newStatus,
        error: allSucceeded ? null : (uploadResults.find(r => !r.success)?.error || 'partial-failure'),
        downloadUrl,
        retryAttemptedAt: FieldValue.serverTimestamp(),
        retriedAt: allSucceeded ? FieldValue.serverTimestamp() : null
      });
    }

    // Delete file if all uploads succeeded
    if (allSucceeded) {
      markRecordingCompleted(fileName);
      try { await fs.promises.unlink(filePath); } catch (_) { }
    }

    return {
      success: allSucceeded,
      partial: anySucceeded && !allSucceeded,
      results: uploadResults
    };
  } catch (err) {
    log('[retry] upload failed:', err?.message || err);
    if (logId) {
      await updateRecordingLog(logId, {
        status: 'failed',
        error: err?.message || 'retry-failed',
        retryAttemptedAt: FieldValue.serverTimestamp()
      });
    }
    return { success: false, error: err?.message || 'retry-failed' };
  } finally {
    activeUploads.delete(fileName);
  }
}

// Path to the uploaded icon you asked to use for the popup
const POPUP_ICON_PATH = "/mnt/data/a35a616b-074d-4238-a09e-5dcb70efb649.png";
const ADMIN_SETTINGS_CACHE_PATH = path.join(app.getPath("userData"), "admin-settings.json");

// ---------- GLOBALS ----------
let mainWindow = null;
let recorderWindow = null;
let recorderFlushWait = null;
let tray = null;
let isQuiting = false;
let cachedAdminSettings = {};
let adminSettingsReady = false;
const getOrganizationTimezone = () => cachedAdminSettings?.organizationTimezone || DEFAULT_ORGANIZATION_TIMEZONE;
let currentUid = null;
let commandUnsub = null;
let statusInterval = null;
let lastIdleState = false; // track previous idle state
let agentClockedIn = false; // only monitor idle when true
let isAway = false; // track screen lock "away" state

// Presence heartbeat interval (RTDB lastSeen refresh) — 5 minutes per product requirement.
const DESKTOP_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

// RTDB presence (preferred for realtime "connected" state; supports onDisconnect)
let desktopSessionId = null;
let activeUploads = new Set(); // Concurrency lock to prevent parallel processing of the same file
let activeMergeRequests = new Set(); // Concurrency lock to prevent parallel merge requests
let lastCompletedMerge = new Map(); // mergeKey -> timestamp (ms)
let rtdbConnectedCallback = null;
let rtdbConnectedRef = null;
let rtdbPresenceRef = null;
let rtdbPresenceHeartbeatInterval = null;
let sessionStartIsoDate = null;  // Tracks clock-in date for merge operations

const ensureDesktopSessionId = () => {
  if (!desktopSessionId) {
    desktopSessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return desktopSessionId;
};

const isRtdbEnabled = () => Boolean(firebaseConfig?.databaseURL);

function stopRtdbPresence() {
  try {
    if (rtdbConnectedRef && rtdbConnectedCallback) {
      rtdbConnectedRef.off('value', rtdbConnectedCallback);
    }
  } catch (_) { }
  rtdbConnectedRef = null;
  rtdbConnectedCallback = null;

  try {
    if (rtdbPresenceHeartbeatInterval) {
      clearInterval(rtdbPresenceHeartbeatInterval);
      rtdbPresenceHeartbeatInterval = null;
    }
  } catch (_) { }

  rtdbPresenceRef = null;
}

async function setRtdbPresence(uid, payload) {
  if (!uid || !isRtdbEnabled()) return;
  try {
    const authed = await ensureDesktopAuth();
    if (!authed) return;
    await rtdb.ref(`presence/${uid}`).set(payload);
  } catch (_) {
    // best-effort
  }
}

async function setRtdbPresenceOfflineIfSessionMatches(uid) {
  if (!uid || !isRtdbEnabled()) return;
  if (!desktopSessionId) return;
  try {
    const authed = await ensureDesktopAuth();
    if (!authed) return;

    // Guard: don't overwrite a newer desktop instance's presence.
    // Only flip offline if the current RTDB record is for *this* session.
    const ref = rtdb.ref(`presence/${uid}`);
    const snap = await ref.once('value');
    const existing = snap?.val?.() || null;
    const existingSid = existing?.sessionId ? String(existing.sessionId) : null;
    const thisSid = String(desktopSessionId);
    if (existingSid && existingSid !== thisSid) return;

    await ref.set({
      state: 'offline',
      lastSeen: RTDB_SERVER_TIMESTAMP,
      sessionId: desktopSessionId,
      source: 'desktop'
    });
  } catch (_) {
    // best-effort
  }
}

function startRtdbPresence(uid) {
  if (!uid || !isRtdbEnabled()) return;
  stopRtdbPresence();

  // Session id is generated per desktop login/register (not per RTDB reconnect)
  // so we can target force-logout commands to a specific desktop instance.
  ensureDesktopSessionId();
  rtdbPresenceRef = rtdb.ref(`presence/${uid}`);

  const buildOnlinePayload = () => ({
    state: 'online',
    lastSeen: RTDB_SERVER_TIMESTAMP,
    sessionId: desktopSessionId,
    source: 'desktop'
  });

  const buildOfflinePayload = () => ({
    state: 'offline',
    lastSeen: RTDB_SERVER_TIMESTAMP,
    sessionId: desktopSessionId,
    source: 'desktop'
  });

  // Use .info/connected to register onDisconnect once we're actually connected.
  rtdbConnectedRef = rtdb.ref('.info/connected');
  rtdbConnectedCallback = async (snap) => {
    try {
      if (!snap?.val?.()) return;

      // Ensure disconnect will flip us offline.
      try {
        await rtdbPresenceRef.onDisconnect().set(buildOfflinePayload());
      } catch (_) {
        // ignore
      }

      // Mark online now.
      await setRtdbPresence(uid, buildOnlinePayload());
    } catch (_) {
      // ignore
    }
  };

  try {
    rtdbConnectedRef.on('value', rtdbConnectedCallback);
  } catch (_) {
    // ignore
  }

  // Heartbeat refresh (5 minutes) to update lastSeen.
  rtdbPresenceHeartbeatInterval = setInterval(() => {
    setRtdbPresence(uid, buildOnlinePayload()).catch(() => { });
  }, DESKTOP_HEARTBEAT_INTERVAL_MS);
}



function getIsoDateFromMs(ms) {
  try {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (_) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

function getIsoTimeFromMs(ms) {
  try {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}-${mm}-${ss}`;
  } catch (_) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${hh}-${mm}-${ss}`;
  }
}

async function retryPendingRecordingUploadsOnLogin(options = {}) {
  // Only retry when we're registered and authenticated.
  if (!currentUid) return;
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) return;
    const entries = fs.readdirSync(RECORDINGS_DIR).filter((n) => typeof n === 'string' && n.toLowerCase().endsWith('.webm'));
    if (!entries.length) return;

    // Stability window: skip files modified very recently.
    // On forced logout, we may bypass this to flush recordings before sign-out.
    const ignoreStability = !!options?.ignoreStability;
    const STABLE_FOR_MS = Number.isFinite(options?.stableForMs)
      ? Math.max(0, options.stableForMs)
      : (2 * 60 * 1000);
    const nowMs = Date.now();

    for (const fileName of entries) {
      if (!currentUid) return;
      if (activeUploads.has(fileName)) {
        log(`[uploads] skipping retry for ${fileName} - currently active`);
        continue;
      }

      const filePath = path.join(RECORDINGS_DIR, fileName);
      let stat;
      try {
        stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size <= 0) continue;
        if (!ignoreStability && nowMs - stat.mtimeMs < STABLE_FOR_MS) continue;
      } catch (_) {
        continue;
      }

      if (isRecordingCompleted(fileName)) {
        // File might remain if delete previously failed — clean it up.
        try { await fs.promises.unlink(filePath); } catch (_) { }
        continue;
      }

      const enabledTargets = [];
      if (shouldUploadToDropbox()) enabledTargets.push('dropbox');
      if (shouldUploadToGoogleSheets()) enabledTargets.push('googleSheets');
      if (shouldUploadToHttp()) enabledTargets.push('http');
      if (!enabledTargets.length) continue;

      // If all currently enabled targets already succeeded (per manifest), mark complete and delete.
      const allDone = enabledTargets.every((t) => isTargetUploaded(fileName, t));
      if (allDone) {
        markRecordingCompleted(fileName);
        try { await fs.promises.unlink(filePath); } catch (_) { }
        continue;
      }

      // Log which targets need retry
      const needsRetry = enabledTargets.filter((t) => !isTargetUploaded(fileName, t));
      log('[uploads] retry needed for file:', fileName, 'targets:', needsRetry.join(', '));

      const entry = getManifestEntry(fileName) || {};
      const ownerUid = entry.ownerUid || null;
      const ownerName = entry.ownerName || null;

      // Owner-check: Skip files that belong to a different user
      // This prevents uploading recordings to the wrong user's account
      if (ownerUid && ownerUid !== currentUid) {
        log('[uploads] skipping file owned by different user:', ownerUid, 'current:', currentUid);

        // Log pending status so admin can see which files are waiting for their owner
        await logRecordingEvent({
          userId: ownerUid,
          userName: ownerName,
          fileName,
          status: 'pending',
          fileSize: stat.size,
          error: 'waiting-for-owner-login'
        });
        continue;
      }

      // Use the file timestamp for stable paths and names across retries.
      const safeNameSource = ownerName || ownerUid || cachedDisplayName || currentUid || 'unknown';
      const safeName = String(safeNameSource).replace(/[\/:*?"<>|]/g, '-');
      const isoDate = getIsoDateFromMs(stat.mtimeMs);
      const isoTime = getIsoTimeFromMs(stat.mtimeMs);
      const googleDriveFileName = `${safeName}-${isoDate}-${isoTime}-${fileName}`.replace(/[\/:*?"<>|]/g, '-');

      if (enabledTargets.includes('dropbox') && !isTargetUploaded(fileName, 'dropbox')) {
        const dropboxPath = `/recordings/${safeName}/${isoDate}/${isoTime}-${fileName}`;
        log("[uploads] retrying Dropbox upload:", dropboxPath);
        const dropboxResult = await uploadToDropboxWithPath(filePath, dropboxPath);
        setTargetUploadResult(fileName, 'dropbox', { success: !!dropboxResult?.success, error: dropboxResult?.error || dropboxResult?.reason || null });
      }

      if (enabledTargets.includes('googleSheets') && !isTargetUploaded(fileName, 'googleSheets')) {
        log("[uploads] retrying Google upload:", filePath);
        const googleResult = await uploadRecordingToGoogleTargets({
          filePath,
          fileName,
          safeName,
          isoDate,
          googleFileName: googleDriveFileName
        });
        setTargetUploadResult(fileName, 'googleSheets', { success: !!googleResult?.success, error: googleResult?.error || googleResult?.reason || null });
      }

      if (enabledTargets.includes('http') && !isTargetUploaded(fileName, 'http')) {
        log('[uploads] retrying HTTP upload:', filePath);
        const httpResult = await uploadToHttpTarget({ filePath, fileName, safeName, isoDate, isoTime });
        log('[uploads] HTTP upload result:', httpResult.success ? 'success' : (httpResult.error || 'failed'));
        setTargetUploadResult(fileName, 'http', { success: !!httpResult?.success, error: httpResult?.error || httpResult?.reason || null });

        // Log to recordingLogs collection so failed retries appear in Recording Logs panel
        await logRecordingEvent({
          userId: ownerUid || currentUid,
          userName: ownerName || cachedDisplayName,
          fileName,
          status: httpResult.success ? 'success' : 'failed',
          uploadTarget: 'http',
          fileSize: stat?.size || null,
          error: httpResult.success ? null : (httpResult.error || httpResult.reason || 'http-upload-failed')
        });
      }

      const allSucceededAfter = enabledTargets.every((t) => isTargetUploaded(fileName, t));
      if (allSucceededAfter) {
        markRecordingCompleted(fileName);
        try { await fs.promises.unlink(filePath); } catch (_) { }
      }
    }
  } catch (err) {
    log('[uploads] retry scan failed', err?.message || err);
  }
}

function getRecordingSegmentIntervalMs() {
  const rawMinutes = cachedAdminSettings?.recordingSegmentMinutes ?? process.env.RECORDING_SEGMENT_MINUTES ?? 5;
  const minutes = Number(rawMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.max(1, minutes) * 60 * 1000;
}

function stopRecordingSegmentLoop() {
  if (recordingSegmentInterval) {
    clearInterval(recordingSegmentInterval);
    recordingSegmentInterval = null;
  }
}

function startRecordingSegmentLoop() {
  const intervalMs = getRecordingSegmentIntervalMs();
  if (!intervalMs) {
    stopRecordingSegmentLoop();
    return;
  }
  if (recordingSegmentInterval) return;
  recordingSegmentInterval = setInterval(async () => {
    if (!currentUid || !agentClockedIn) return;
    if (!isRecordingActive) return;
    if (!isAutoRecordingEnabled()) return;
    if (recordingSegmentInFlight) return;
    recordingSegmentInFlight = true;
    try {
      await stopBackgroundRecordingAndFlush({ timeoutMs: 5000, payload: { suppressAutoResume: true } });
      if (currentUid && agentClockedIn && isRecordingActive && isAutoRecordingEnabled()) {
        startBackgroundRecording();
      }
    } catch (_) { }
    finally {
      recordingSegmentInFlight = false;
    }
  }, intervalMs);
}

function restartRecordingSegmentLoop() {
  stopRecordingSegmentLoop();
  startRecordingSegmentLoop();
}

function startUploadRetryLoop() {
  if (uploadRetryInterval) return;
  const intervalMs = 5 * 60 * 1000;
  uploadRetryInterval = setInterval(async () => {
    if (!currentUid) return;
    if (!cachedAdminSettings?.autoUpload) return;
    try {
      await retryPendingRecordingUploadsOnLogin();
    } catch (_) { }
  }, intervalMs);
}

// Listener for retry commands from admin panel
let recordingRetryCommandsUnsub = null;
function startRecordingRetryCommandsListener() {
  if (recordingRetryCommandsUnsub) return;
  if (!currentUid) return;

  const machineName = os.hostname();
  log('[retryCommands] Starting listener for machine:', machineName);

  recordingRetryCommandsUnsub = db.collection('recordingRetryCommands')
    .where('machineName', '==', machineName)
    .where('status', '==', 'pending')
    .onSnapshot(async (snapshot) => {
      if (snapshot.empty) return;

      for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        const commandId = docSnap.id;
        const { fileName, logId } = data;

        if (!fileName) continue;

        log('[retryCommands] Processing retry command:', commandId, fileName);

        // Mark as processing
        try {
          await docSnap.ref.update({ status: 'processing', processedAt: FieldValue.serverTimestamp() });
        } catch (_) { }

        // Attempt the retry
        const result = await retrySpecificRecordingUpload(fileName, logId || commandId);

        // Update command status
        try {
          await docSnap.ref.update({
            status: result.success ? 'completed' : 'failed',
            result: result.success ? { message: 'Upload successful' } : null,
            error: result.error || null,
            completedAt: FieldValue.serverTimestamp()
          });
        } catch (err) {
          log('[retryCommands] Failed to update command status:', err?.message || err);
        }

        log('[retryCommands] Retry result:', commandId, result.success ? 'success' : result.error);
      }
    }, (error) => {
      log('[retryCommands] Listener error:', error?.message || error);
    });
}

function stopRecordingRetryCommandsListener() {
  if (recordingRetryCommandsUnsub) {
    try { recordingRetryCommandsUnsub(); } catch (_) { }
    recordingRetryCommandsUnsub = null;
  }
}
let isRecordingActive = false; // track recording
let popupWindow = null; // reference to the transient popup
let cachedDisplayName = null; // cached user displayName (filled on register)
const DEFAULT_LOGIN_ROUTE_HASH = '#/login';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://tracker-5.vercel.app';

let recordingSegmentInterval = null;
let recordingSegmentInFlight = false;
let uploadRetryInterval = null;

// ---------- HEALTH / CRASH TELEMETRY (best-effort) ----------
const HEALTH_EVENT_STACK_LIMIT = 2000;
const HEALTH_LOG_PATH = path.join(app.getPath("userData"), "health-events.jsonl");
log("[health] local telemetry:", HEALTH_LOG_PATH);
const WATCHDOG_PING_INTERVAL_MS = 30000;
const WATCHDOG_PING_TIMEOUT_MS = 5000;
const WATCHDOG_STALL_THRESHOLD_MS = 2 * 60 * 1000;
const WATCHDOG_RECOVERY_COOLDOWN_MS = 60 * 1000;
const MAIN_LAG_CHECK_INTERVAL_MS = 1000;
const MAIN_LAG_THRESHOLD_MS = 10 * 1000;
const MAIN_LAG_SEVERE_THRESHOLD_MS = 30 * 1000;
const METRICS_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const DROPBOX_SIMPLE_UPLOAD_LIMIT = 150 * 1024 * 1024; // ~150MB Dropbox simple upload limit
const DROPBOX_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks for upload sessions
let lastRendererPongMs = Date.now();
let watchdogInterval = null;
let watchdogPingTimeout = null;
let lastRecoveryAttemptMs = 0;
let mainLagInterval = null;
let lastMainLagTickMs = Date.now();
let metricsInterval = null;

const safeStringify = (value) => {
  try { return JSON.stringify(value); } catch { return String(value); }
};

const trimStack = (stack) => {
  if (!stack) return undefined;
  const raw = String(stack);
  return raw.length > HEALTH_EVENT_STACK_LIMIT ? raw.slice(0, HEALTH_EVENT_STACK_LIMIT) : raw;
};

const appendHealthLogLine = (entry) => {
  try {
    const line = `${safeStringify(entry)}\n`;
    fs.appendFileSync(HEALTH_LOG_PATH, line, { encoding: "utf8" });
  } catch (_) {
    // ignore
  }
};

const snapshotLocal = (type, details = {}) => {
  try {
    appendHealthLogLine({
      at: new Date().toISOString(),
      type: String(type || "snapshot"),
      message: safeStringify(details),
      stack: null,
      uid: currentUid || null
    });
  } catch (_) { }
};

const getProcessMetrics = () => {
  try {
    const mem = process.memoryUsage();
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external
    };
  } catch (_) {
    return null;
  }
};

async function writeAgentHealth(uid, payload = {}) {
  if (!uid) return false;
  try {
    const authed = await ensureDesktopAuth();
    if (!authed) return false;
    await db.collection("agentStatus").doc(uid).set({
      ...payload,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  } catch (_) {
    return false;
  }
}

async function recordHealthEvent(type, details) {
  const uid = currentUid;
  const message = typeof details === 'string'
    ? details
    : (details?.message || details?.reason || details?.error || safeStringify(details));
  const stack = trimStack(details?.stack);

  // Always persist locally so we can debug "silent" crashes where Firestore writes aren't possible.
  appendHealthLogLine({
    at: new Date().toISOString(),
    type: String(type || "unknown"),
    message: String(message || type || "unknown"),
    stack: stack ? String(stack) : null,
    uid: uid || null
  });

  if (!uid) return false;

  return await writeAgentHealth(uid, {
    lastHealthEventAt: FieldValue.serverTimestamp(),
    lastHealthEventType: String(type || 'unknown'),
    lastHealthEventMessage: String(message || type || 'unknown'),
    lastHealthEventStack: stack ? String(stack) : FieldValue.delete()
  });
}

function canAttemptRecovery() {
  return Date.now() - lastRecoveryAttemptMs > WATCHDOG_RECOVERY_COOLDOWN_MS;
}

async function attemptDesktopRecovery(reason = "watchdog") {
  if (!currentUid) return false;
  if (!canAttemptRecovery()) return false;
  lastRecoveryAttemptMs = Date.now();
  log("[watchdog] attempting recovery:", reason);
  await recordHealthEvent("watchdog_recovery", { reason });

  // Best-effort: bounce Firestore network to recover from stuck sockets/offline caching states.
  try {
    if (typeof db.disableNetwork === "function") await db.disableNetwork();
    await new Promise((r) => setTimeout(r, 500));
    if (typeof db.enableNetwork === "function") await db.enableNetwork();
  } catch (e) {
    log("[watchdog] firestore network bounce failed", e?.message || e);
  }

  try {
    const authed = await ensureDesktopAuth();
    if (!authed) {
      // If auth is blocked (e.g., SecureToken requests blocked), recovery won't help.
      // Avoid hot-looping and leave it to renderer re-register flow.
      return false;
    }
  } catch (_) { }

  try {
    // Restart watches/loops
    stopAgentStatusLoop();
    startAgentStatusLoop(currentUid);
    stopAgentStatusWatch();
    startAgentStatusWatch(currentUid);
    stopAutoClockConfigWatch();
    startAutoClockConfigWatch(currentUid);
  } catch (_) { }

  try {
    await flushPendingAgentStatuses();
  } catch (_) { }

  try {
    await reassertDesktopStatus(currentUid);
  } catch (_) { }

  // Last resort: if we still have queued writes, reload the renderer to reset the app state.
  try {
    if (pendingAgentStatuses.length > 0) {
      await recordHealthEvent("watchdog_recovery_incomplete", { reason, pending: pendingAgentStatuses.length });
      try { mainWindow?.webContents?.reload?.(); } catch (_) { }
    }
  } catch (_) { }

  return true;
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  if (watchdogPingTimeout) {
    clearTimeout(watchdogPingTimeout);
    watchdogPingTimeout = null;
  }
}

function startWatchdog() {
  stopWatchdog();
  watchdogInterval = setInterval(async () => {
    try {
      // 1) Ping renderer and reload if it stops responding
      if (mainWindow?.webContents) {
        const pingId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try { mainWindow.webContents.send("health-ping", { id: pingId }); } catch (_) { }
        if (watchdogPingTimeout) clearTimeout(watchdogPingTimeout);
        watchdogPingTimeout = setTimeout(async () => {
          watchdogPingTimeout = null;
          const age = Date.now() - lastRendererPongMs;
          if (age <= WATCHDOG_PING_INTERVAL_MS + WATCHDOG_PING_TIMEOUT_MS) return;
          log("[watchdog] renderer pong stale:", age);
          await recordHealthEvent("watchdog_renderer_stale", { ageMs: age });
          try { mainWindow?.webContents?.reload?.(); } catch (_) { }
        }, WATCHDOG_PING_TIMEOUT_MS);
      }

      // 2) If we haven't had a successful agentStatus write in a while while active, try recovery.
      const active = Boolean(currentUid && (agentClockedIn || isRecordingActive));
      const sinceWrite = Date.now() - (lastStatusWriteMs || 0);
      // In transitions-only mode, going a long time with no writes can be normal.
      // Only treat it as "stalled" when we actually have pending status writes queued.
      const hasPendingStatusWrites = pendingAgentStatuses.length > 0;
      if (active && hasPendingStatusWrites && sinceWrite > WATCHDOG_STALL_THRESHOLD_MS) {
        await attemptDesktopRecovery("status_write_stalled");
      }
    } catch (e) {
      // Avoid cascading failures
      log("[watchdog] error", e?.message || e);
    }
  }, WATCHDOG_PING_INTERVAL_MS);
}

function stopMainLagMonitor() {
  if (mainLagInterval) {
    clearInterval(mainLagInterval);
    mainLagInterval = null;
  }
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

function startMainLagMonitor() {
  stopMainLagMonitor();

  lastMainLagTickMs = Date.now();
  mainLagInterval = setInterval(async () => {
    const now = Date.now();
    const driftMs = now - lastMainLagTickMs - MAIN_LAG_CHECK_INTERVAL_MS;
    lastMainLagTickMs = now;

    if (driftMs > MAIN_LAG_THRESHOLD_MS) {
      const metrics = getProcessMetrics();
      await recordHealthEvent("main_event_loop_lag", {
        driftMs,
        thresholdMs: MAIN_LAG_THRESHOLD_MS,
        metrics
      });

      if (driftMs > MAIN_LAG_SEVERE_THRESHOLD_MS) {
        await attemptDesktopRecovery("main_event_loop_lag_severe");
        try { mainWindow?.webContents?.reload?.(); } catch (_) { }
      }
    }
  }, MAIN_LAG_CHECK_INTERVAL_MS);

  metricsInterval = setInterval(() => {
    snapshotLocal("metrics_snapshot", { metrics: getProcessMetrics() });
  }, METRICS_SNAPSHOT_INTERVAL_MS);
}

process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException", err);
  recordHealthEvent("main_uncaughtException", { message: err?.message, stack: err?.stack });
});

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection", reason);
  recordHealthEvent("main_unhandledRejection", { message: safeStringify(reason) });
});

app.on("render-process-gone", (_event, _webContents, details) => {
  console.error("[app] render-process-gone", details);
  recordHealthEvent("render_process_gone", details || {});
});

app.on("child-process-gone", (_event, details) => {
  console.error("[app] child-process-gone", details);
  recordHealthEvent("child_process_gone", details || {});
});

ipcMain.on("health-pong", (_event, payload) => {
  lastRendererPongMs = Date.now();
  // If we were in a recovery loop, this acts as a good sign.
  if (payload?.id) {
    // no-op, kept for correlation when debugging
  }
});
// Use .ico on Windows for proper taskbar/shortcut branding; png elsewhere.
// Resolve icon for dev (repo path) and packaged builds (resourcesPath).
const ICON_CANDIDATES = [
  path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  process.resourcesPath ? path.join(process.resourcesPath, process.platform === 'win32' ? 'icon.ico' : 'icon.png') : null
].filter(Boolean);

const resolveAppIcon = () => {
  for (const candidate of ICON_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      try {
        const img = nativeImage.createFromPath(candidate);
        if (!img.isEmpty()) {
          log('[icon] using', candidate);
          return img;
        }
      } catch (err) {
        log('[icon] failed to load', candidate, err?.message || err);
      }
    }
  }
  log('[icon] no icon found, falling back to default');
  return undefined;
};

const APP_ICON = resolveAppIcon();

// Single-instance lock prevents duplicate processes and tray icons.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });
}

let manualBreakReminderWindow = null;
let manualBreakReminderPayloadKey = null;

function persistAdminSettingsCache(settings) {
  try {
    fs.writeFileSync(ADMIN_SETTINGS_CACHE_PATH, JSON.stringify(settings || {}, null, 2), "utf8");
  } catch (error) {
    console.warn("[adminSettings] failed to persist cache", error?.message || error);
  }
}

function hydrateAdminSettingsFromDisk() {
  try {
    if (!fs.existsSync(ADMIN_SETTINGS_CACHE_PATH)) return;
    const raw = fs.readFileSync(ADMIN_SETTINGS_CACHE_PATH, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      cachedAdminSettings = parsed;
      adminSettingsReady = true;
      log("[adminSettings] hydrated cached settings from disk");
    }
  } catch (error) {
    console.warn("[adminSettings] failed to load cached settings", error?.message || error);
  }
}

hydrateAdminSettingsFromDisk();

let lastForceLogoutRequestId = null;
let forceLogoutRequestInFlight = false;

let autoClockOutInterval = null;
let lastAutoClockOutTargetKey = null;
let agentStatusUnsub = null; // remote Firestore watch for agentStatus
let autoClockConfigUnsub = null;
let autoClockSlots = {};
let currentShiftDate = null;
let manualBreakActive = false;
let manualBreakStartedAtMs = null;
let manualBreakReminderTimer = null;
let autoResumeInFlight = false;
const AUTO_RESUME_BASE_DELAY_MS = 5000;
const AUTO_RESUME_MAX_DELAY_MS = 60000;
let autoResumeRetryDelayMs = AUTO_RESUME_BASE_DELAY_MS;
let autoResumeRetryTimer = null;
let lastStatusWriteMs = Date.now();
let statusHealthInterval = null;
let lastDesktopToken = null;
let lastAuthRequiredEmitMs = 0;
const AUTH_REQUIRED_EMIT_COOLDOWN_MS = 30 * 1000;

function isUnauthenticatedError(err) {
  const msg = String(err?.message || err || "");
  return (
    err?.code === 16 ||
    /unauthenticated/i.test(msg) ||
    /missing or invalid authentication/i.test(msg) ||
    /auth-missing/i.test(msg)
  );
}

function isSecureTokenBlockedError(err) {
  const msg = String(err?.message || err || "");
  return (
    /securetoken\.googleapis\.com/i.test(msg) &&
    /are-blocked|blocked/i.test(msg)
  );
}

function requestRendererReauth(reason = "unknown") {
  const now = Date.now();
  if (now - lastAuthRequiredEmitMs < AUTH_REQUIRED_EMIT_COOLDOWN_MS) return;
  lastAuthRequiredEmitMs = now;
  try {
    log("[auth] requesting renderer re-register:", reason);
    mainWindow?.webContents?.send?.("desktop-auth-required", { reason });
  } catch (_) { }
}

function clearAutoResumeRetryTimer() {
  if (autoResumeRetryTimer) {
    clearTimeout(autoResumeRetryTimer);
    autoResumeRetryTimer = null;
  }
}

function resetAutoResumeRetry() {
  clearAutoResumeRetryTimer();
  autoResumeRetryDelayMs = AUTO_RESUME_BASE_DELAY_MS;
}

function clearManualBreakReminderTimer() {
  if (manualBreakReminderTimer) {
    clearTimeout(manualBreakReminderTimer);
    manualBreakReminderTimer = null;
  }
}

function scheduleManualBreakReminderIfNeeded() {
  try {
    clearManualBreakReminderTimer();
    const timeoutMins = Number(cachedAdminSettings?.manualBreakTimeoutMinutes) || 0;
    if (!manualBreakActive || timeoutMins <= 0 || !manualBreakStartedAtMs) return;

    const elapsedMs = Date.now() - manualBreakStartedAtMs;
    const remainingMs = (timeoutMins * 60 * 1000) - elapsedMs;
    if (remainingMs <= 0) {
      showManualBreakReminderPopup({ timeoutMins });
      return;
    }

    manualBreakReminderTimer = setTimeout(() => {
      manualBreakReminderTimer = null;
      if (manualBreakActive) showManualBreakReminderPopup({ timeoutMins });
    }, remainingMs);
  } catch (_) {
    // ignore
  }
}

function recordStatusWriteSuccess() {
  lastStatusWriteMs = Date.now();
}

function startStatusHealthCheck() {
  // watchdog disabled for transitions-only flow
}

function stopStatusHealthCheck() {
  if (statusHealthInterval) {
    clearInterval(statusHealthInterval);
    statusHealthInterval = null;
  }
}

async function ensureDesktopAuth() {
  try {
    if (!currentUid) {
      log('[ensureDesktopAuth] no currentUid');
      return false;
    }
    const user = clientAuth.currentUser;
    if (user && user.uid === currentUid) return true;

    // If we have a cached custom token, try it first (best-effort).
    if (lastDesktopToken) {
      try {
        await clientAuth.signInWithCustomToken(lastDesktopToken);
        log('[ensureDesktopAuth] re-signed in with cached desktop token');
        return true;
      } catch (err) {
        console.warn('[ensureDesktopAuth] reauth failed', err?.message || err);
        if (isSecureTokenBlockedError(err)) {
          // Environment/network is blocking SecureToken; avoid hammering reauth.
          await recordHealthEvent("auth_securetoken_blocked", { message: err?.message || String(err) });
          return false;
        }
      }
    }

    // Ask the renderer to fetch a fresh desktop token and re-register.
    requestRendererReauth(!user ? "missing_currentUser" : "uid_mismatch");
  } catch (err) {
    console.warn('[ensureDesktopAuth] error', err?.message || err);
  }
  return false;
}

// Dropbox token management
let cachedDropboxAccessToken = null;
let cachedDropboxRefreshToken = null;
let dropboxTokenExpiry = null;

// Allow media (screen) capture in the recorder window without prompting
function ensureMediaPermissions(webContentsInstance) {
  try {
    if (!webContentsInstance || !webContentsInstance.session) return;
    const ses = webContentsInstance.session;
    if (ses.__mediaHandlerSet) return;
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission === 'media') {
        return callback(true);
      }
      callback(false);
    });
    ses.__mediaHandlerSet = true;
  } catch (err) {
    log('[permissions] failed to set media handler', err?.message || err);
  }
}

const GOOGLE_UPLOAD_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets"
];
let googleAuthClient = null;
let googleSheetsClient = null;
let googleDriveClient = null;
let googleSetupError = null;

configureGoogleIntegrations();

const pendingAgentStatuses = [];
let pendingStatusRetryTimer = null;

function schedulePendingStatusFlush(delayMs = 3000) {
  if (pendingStatusRetryTimer) return;
  pendingStatusRetryTimer = setTimeout(async () => {
    pendingStatusRetryTimer = null;
    try {
      await flushPendingAgentStatuses();
    } catch (err) {
      log('[pending-status] flush failed', err?.message || err);
      // backoff retry to avoid dropping status updates on transient failures
      schedulePendingStatusFlush(Math.min(delayMs * 2, 30000));
    }
  }, delayMs);
}

async function reconcileRecordingAfterRegister(uid) {
  try {
    if (!uid) return;
    if (!adminSettingsReady) return;

    const snap = await db.collection('agentStatus').doc(uid).get();
    if (!snap.exists) return;
    const data = snap.data() || {};
    const status = String(data.status || '').toLowerCase();
    const isActive = status === 'working' || status === 'online';
    if (!isActive) return;

    const wasRecording = Boolean(data.isRecording);
    resetAutoResumeRetry();

    const settings = cachedAdminSettings || {};
    const mode = String(settings.recordingMode || 'auto').toLowerCase();
    if (settings.allowRecording === false) return;

    // Auto mode: ensure recording is running when agent is active.
    if (mode === 'auto') {
      if (!wasRecording) {
        try {
          isRecordingActive = true;
          startBackgroundRecording();
        } catch (e) {
          console.warn('[reconcileRecordingAfterRegister] start send failed', e?.message || e);
        }
      } else {
        // Keep the existing recording running; just sync flags.
        isRecordingActive = true;
      }

      await db.collection('agentStatus').doc(uid).set({
        status: 'working',
        isRecording: true,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => { });

      agentClockedIn = true;
      return;
    }

    // Manual mode: only resume if an admin previously started recording (isRecording=true).
    if (mode === 'manual') {
      if (!wasRecording) return;

      if (!isRecordingActive) {
        try {
          isRecordingActive = true;
          showRecordingPopup('Recording resumed');
          startBackgroundRecording();
        } catch (e) {
          console.warn('[reconcileRecordingAfterRegister] manual resume failed', e?.message || e);
        }
      }

      await db.collection('agentStatus').doc(uid).set({
        status: 'working',
        isRecording: true,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => { });

      agentClockedIn = true;
      return;
    }

    // Unknown mode: do nothing.
  } catch (err) {
    console.warn('[reconcileRecordingAfterRegister] failed', err?.message || err);
  }
}

async function reassertDesktopStatus(uid) {
  if (!uid) return;
  try {
    const snap = await db.collection('agentStatus').doc(uid).get();
    if (!snap.exists) return;
    const data = snap.data() || {};
    const status = String(data.status || '').toLowerCase();
    const manualBreak = data.manualBreak === true;
    // Only refresh when the server already thinks we're online/working and not on manual break
    if (manualBreak) return;
    if (status === 'working' || status === 'online') {
      await db.collection('agentStatus').doc(uid).set({
        status: 'online',
        manualBreak: false,
        breakStartedAt: FieldValue.delete(),
        isIdle: false,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => { });
    }
  } catch (err) {
    console.warn('[reassertDesktopStatus] failed', err?.message || err);
  }
}

const isAutoRecordingEnabled = () => {
  // Safety: don't auto-start recording until admin settings are known.
  // Prevents incorrect default-to-auto behavior when the app boots before settings sync.
  if (!adminSettingsReady) return false;
  const settings = cachedAdminSettings || {};
  const mode = String(settings.recordingMode || 'auto').toLowerCase();
  if (settings.allowRecording === false) return false;
  return mode === 'auto';
};

async function resumeRecordingIfNeeded(uid) {
  if (!uid || !agentClockedIn) return;
  if (isAway) return; // Don't resume recording while screen is locked
  if (!isAutoRecordingEnabled()) return;
  if (isRecordingActive) {
    log("Recording already active, skipping auto resume.");
    return;
  }

  isRecordingActive = true;
  try {
    await db.collection('agentStatus').doc(uid)
      .set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true });
    recordStatusWriteSuccess();
  } catch (_) { }
  showRecordingPopup("Recording resumed");
  startBackgroundRecording();
}

function scheduleAutoResumeRecording(options = {}) {
  const { force = false, reason = null } = options;
  if (autoResumeInFlight) return;
  if (!currentUid || !agentClockedIn) return;
  if (isAway) return; // Don't auto-resume recording while screen is locked
  if (!isAutoRecordingEnabled()) return;
  if (!force && !isRecordingActive) return;

  autoResumeInFlight = true;
  if (!force) {
    isRecordingActive = false;
  }

  resetAutoResumeRetry();
  const label = reason ? ` (${reason})` : "";
  log(`[recording] Recorder stop detected${label}; attempting auto-resume.`);

  resumeRecordingIfNeeded(currentUid)
    .then(() => {
      resetAutoResumeRetry();
    })
    .catch((err) => {
      log("[recording] Auto-resume attempt failed", err?.message || err);
      scheduleAutoResumeRetry(reason || err?.message || "retry");
    })
    .finally(() => {
      autoResumeInFlight = false;
    });
}

function scheduleAutoResumeRetry(reason = "retry") {
  if (!currentUid || !agentClockedIn) return;
  if (isAway) return; // Don't retry resume while screen is locked
  clearAutoResumeRetryTimer();
  const delay = autoResumeRetryDelayMs;
  autoResumeRetryTimer = setTimeout(() => {
    autoResumeRetryTimer = null;
    scheduleAutoResumeRecording({ force: true, reason });
  }, delay);
  log(`[recording] Auto-resume retry in ${Math.round(delay / 1000)}s (${reason})`);
  autoResumeRetryDelayMs = Math.min(autoResumeRetryDelayMs * 2, AUTO_RESUME_MAX_DELAY_MS);
}

async function clockOutAndSignOutDesktop(reason = "clocked_out_and_signed_out", options = {}) {
  if (!currentUid) return false;

  const notifyRenderer = options?.notifyRenderer !== false;
  const uid = currentUid;
  const forceLogoutSource = options?.forceLogoutSource || null;

  agentClockedIn = false;
  stopAgentStatusLoop();
  stopRecordingRetryCommandsListener();
  // Best-effort: explicitly mark desktop offline in RTDB so the console/UI doesn't
  // show a stuck `online` state if onDisconnect doesn't fire for any reason.
  // Guarded by sessionId match to avoid clobbering a newer desktop session.
  try { await setRtdbPresenceOfflineIfSessionMatches(uid); } catch (_) { }
  stopRtdbPresence();

  const wasRecording = isRecordingActive;
  isRecordingActive = false;
  autoResumeInFlight = false;
  resetAutoResumeRetry();

  await db.collection('agentStatus').doc(uid)
    .set({ isRecording: false }, { merge: true })
    .catch(() => { });

  if (wasRecording) showRecordingPopup("Recording stopped");
  // Use flush to ensure current recording segment is saved before upload
  await stopBackgroundRecordingAndFlush({ payload: { stopReason: 'signed_out' } });

  // Update worklog status to clocked_out
  try {
    const worklogsSnap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (!worklogsSnap.empty) {
      const worklogDoc = worklogsSnap.docs[0];
      const worklogData = worklogDoc.data() || {};
      const breaks = Array.isArray(worklogData.breaks) ? worklogData.breaks : [];

      // Close any open break entries
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (!breaks[i].endTime) {
          breaks[i] = { ...breaks[i], endTime: FieldValue.serverTimestamp() };
        }
      }

      await worklogDoc.ref.update({
        status: 'clocked_out',
        clockOutTime: FieldValue.serverTimestamp(),
        lastEventTimestamp: FieldValue.serverTimestamp(),
        breaks,
        activities: (() => {
          const activities = Array.isArray(worklogData.activities) ? worklogData.activities : [];
          if (activities.length > 0) {
            const last = activities[activities.length - 1];
            if (!last.endTime) {
              activities[activities.length - 1] = { ...last, endTime: FieldValue.serverTimestamp() };
            }
          }
          return activities;
        })()
      });
      log('[clockOutAndSignOutDesktop] Worklog updated to clocked_out');
    }
  } catch (e) {
    log('[clockOutAndSignOutDesktop] Failed to update worklog:', e?.message || e);
  }

  // Best-effort: flush any pending uploads before losing auth / returning to login.
  // This is especially important for mid-shift handoffs where the old machine must upload.
  try {
    await retryPendingRecordingUploadsOnLogin({ ignoreStability: true, stableForMs: 0 });
  } catch (_) {
    // ignore
  }

  // Auto-merge recording segments (same as performClockOut)
  try {
    let agentName = 'Unknown';
    try {
      const userDoc = await db.collection('users').doc(uid).get();
      if (userDoc.exists) {
        const data = userDoc.data();
        agentName = (data.displayName || data.name || data.email || 'Unknown')
          .replace(/[^a-zA-Z0-9_\-\s]/g, '_')
          .trim();
      }
    } catch (e) {
      log('[merge] Failed to fetch user name:', e?.message);
    }

    const now = new Date();
    // Use session start date if available (for night shifts), otherwise fallback to current date
    const isoDate = sessionStartIsoDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Fire and forget - don't wait for merge to complete
    requestSegmentMerge(agentName, isoDate, true)
      .then(result => {
        if (result.success) log(`[merge] Segments merged for ${agentName} on ${isoDate}`);
        else log(`[merge] Merge skipped/failed:`, result.reason || result.error);
      })
      .catch(err => log('[merge] Merge error:', err?.message || err));
  } catch (mergeErr) {
    log('[merge] Error during auto-merge:', mergeErr?.message || mergeErr);
  }

  await db.collection('agentStatus').doc(uid).set({
    status: 'offline',
    isIdle: false,
    isAway: false,
    manualBreak: false,
    idleReason: FieldValue.delete(),
    lockedBySystem: false,
    lastUpdate: FieldValue.serverTimestamp()
  }, { merge: true }).catch(() => { });

  // Keep the user profile in sync when desktop drives the clock-out/sign-out flow.
  // In multi-desktop handoff scenarios, avoid clobbering the new desktop's session.
  try {
    const userRef = db.collection("users").doc(uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? (snap.data() || {}) : {};
      const activeSid = data?.activeDesktopSessionId ? String(data.activeDesktopSessionId) : null;
      const thisSid = desktopSessionId ? String(desktopSessionId) : null;

      if (activeSid && thisSid && activeSid !== thisSid) {
        // Another desktop has taken ownership; do not flip global login state.
        tx.set(userRef, {
          lastClockOut: FieldValue.serverTimestamp(),
          sessionClearedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return;
      }

      tx.set(userRef, {
        isLoggedIn: false,
        activeSession: FieldValue.delete(),
        lastClockOut: FieldValue.serverTimestamp(),
        sessionClearedAt: FieldValue.serverTimestamp(),
        activeDesktopSessionId: FieldValue.delete(),
        activeDesktopSessionStartedAt: FieldValue.delete(),
        activeDesktopMachineName: FieldValue.delete(),
        activeDesktopPlatform: FieldValue.delete()
      }, { merge: true });
    });
  } catch (e) {
    log("[clockOutAndSignOutDesktop] failed to update users session fields", e?.message || e);
  }

  // If we were forced logged out (via desktopCommands or remote requestId), clear the flag(s)
  // while we're still authenticated; otherwise these writes will fail after signOut and the
  // command/request can remain stuck.
  try {
    await db.collection("desktopCommands").doc(uid).set({
      forceLogout: false
    }, { merge: true });
  } catch (e) {
    log("[forceLogout] failed to clear desktopCommands.forceLogout", e?.message || e);
  }

  try {
    const clearPayload = {
      forceLogoutRequestId: FieldValue.delete(),
      forceLogoutRequestedAt: FieldValue.delete(),
      forceLogoutRequestedBy: FieldValue.delete(),
      forceLogoutCompletedAt: FieldValue.serverTimestamp()
    };
    await db.collection("agentStatus").doc(uid).set(clearPayload, { merge: true });
  } catch (e) {
    log("[forceLogout] failed to clear agentStatus forceLogout fields", e?.message || e);
  }

  if (commandUnsub) { try { commandUnsub(); } catch (e) { } commandUnsub = null; }
  stopAgentStatusWatch();
  stopAutoClockConfigWatch();
  pendingAgentStatuses.length = 0;
  manualBreakActive = false;
  isAway = false;
  lastIdleState = false;
  closeManualBreakReminderWindow();

  currentUid = null;
  currentShiftDate = null;
  sessionStartIsoDate = null;
  lastAutoClockOutTargetKey = null;
  desktopSessionId = null;

  try { await clientAuth.signOut(); } catch (err) { console.warn('[clockOutAndSignOutDesktop] signOut failed', err?.message || err); }

  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send("clear-desktop-uid");
      if (notifyRenderer) {
        mainWindow.webContents.send("signed-out", { reason });
      }
    }
  } catch (e) {
    console.warn('[clockOutAndSignOutDesktop] renderer notification failed', e?.message || e);
  }

  lastForceLogoutRequestId = null;
  forceLogoutRequestInFlight = false;

  return true;
}

async function pushIdleStatus(uid, { idleSecs, reason } = {}) {
  if (!uid) return;
  const authed = await ensureDesktopAuth();
  if (!authed) {
    log('[pushIdleStatus] auth missing, skipping write');
    return;
  }
  try {
    await db.collection("agentStatus").doc(uid)
      .set({
        status: "break",
        isIdle: true,
        isAway: false,
        idleSecs,
        idleReason: reason || null,
        lockedBySystem: reason === 'system_lock',
        awayReason: FieldValue.delete(),
        awayStartedAt: FieldValue.delete(),
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true });
    recordStatusWriteSuccess();
  } catch (_) { }
}

async function pushActiveStatus(uid, { idleSecs } = {}) {
  if (!uid) return;
  const authed = await ensureDesktopAuth();
  if (!authed) {
    log('[pushActiveStatus] auth missing, skipping write');
    return;
  }
  try {
    await db.collection("agentStatus").doc(uid)
      .set({
        status: "online",
        isIdle: false,
        idleSecs,
        idleReason: FieldValue.delete(),
        lockedBySystem: false,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true });
    recordStatusWriteSuccess();
  } catch (_) { }
  await resumeRecordingIfNeeded(uid);
}

async function pushAwayStatus(uid, { idleSecs } = {}) {
  if (!uid) return;
  const authed = await ensureDesktopAuth();
  if (!authed) {
    log('[pushAwayStatus] auth missing, skipping write');
    return;
  }
  try {
    await db.collection("agentStatus").doc(uid)
      .set({
        status: "away",
        isIdle: false,
        isAway: true,
        awayReason: 'screen_lock',
        idleSecs,
        idleReason: FieldValue.delete(),
        lockedBySystem: true,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true });
    recordStatusWriteSuccess();
  } catch (_) { }
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

function resetGoogleIntegrations() {
  googleAuthClient = null;
  googleSheetsClient = null;
  googleDriveClient = null;
  googleSetupError = null;
}

function configureGoogleIntegrations() {
  resetGoogleIntegrations();
  const raw = cachedAdminSettings?.googleServiceAccountJson;
  if (!raw) {
    return;
  }
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    googleSetupError = `parse-error: ${error?.message || error}`;
    log("[google] Failed to parse service account JSON", error?.message || error);
    return;
  }
  if (!parsed?.client_email || !parsed?.private_key) {
    googleSetupError = "invalid-service-account-json";
    log("[google] Missing client_email/private_key in service account JSON");
    return;
  }
  try {
    googleAuthClient = new google.auth.JWT(parsed.client_email, null, parsed.private_key, GOOGLE_UPLOAD_SCOPES);
    googleSheetsClient = google.sheets({ version: "v4", auth: googleAuthClient });
    googleDriveClient = google.drive({ version: "v3", auth: googleAuthClient });
    googleSetupError = null;
    log("[google] Service account initialized");
  } catch (error) {
    googleSetupError = error?.message || "google-auth-init-failed";
    log("[google] Failed to initialize Google API clients", error?.message || error);
    resetGoogleIntegrations();
  }
}

async function ensureGoogleAuthorized() {
  if (!googleAuthClient) {
    throw new Error(googleSetupError || "google-not-configured");
  }
  if (typeof googleAuthClient.authorize === "function") {
    await googleAuthClient.authorize();
  }
  return true;
}

function shouldUploadToDropbox() {
  if (!cachedAdminSettings?.autoUpload) return false;
  if (cachedAdminSettings?.uploadToDropbox === false) return false;
  return hasDropboxCredentials();
}

function shouldUploadToGoogleSheets() {
  if (!cachedAdminSettings?.autoUpload) return false;
  if (!cachedAdminSettings?.uploadToGoogleSheets) return false;
  if (!cachedAdminSettings?.googleSpreadsheetId) return false;
  if (!cachedAdminSettings?.googleServiceAccountJson) return false;
  if (!googleSheetsClient || !googleDriveClient || googleSetupError) return false;
  return true;
}

const getHttpUploadConfig = () => {
  const url = (cachedAdminSettings?.httpUploadUrl || '').trim();
  if (!url) return null;
  const token = (cachedAdminSettings?.httpUploadToken || '').trim();
  return { url, token };
};

function shouldUploadToHttp() {
  if (!cachedAdminSettings?.autoUpload) return false;
  if (cachedAdminSettings?.uploadToHttp === false) return false;
  return Boolean(getHttpUploadConfig()?.url);
}

async function uploadToHttpTarget({ filePath, fileName, safeName, isoDate, isoTime }) {
  const config = getHttpUploadConfig();
  if (!config?.url) return { success: false, reason: 'http-not-configured' };
  const shouldRepair = cachedAdminSettings?.httpUploadFfmpegRepairEnabled ?? true;

  try {
    // 1. Pre-flight Ping: Verify server is reachable
    try {
      const pingRes = await fetch(config.url, { method: 'GET', timeout: 5000 });
      if (!pingRes.ok && pingRes.status !== 405 && pingRes.status !== 404) {
        throw new Error(`Server returned ${pingRes.status}`);
      }
    } catch (pingErr) {
      log(`[http-upload] Pre-flight ping failed:`, pingErr.message);
      return { success: false, error: 'server-unreachable', detail: pingErr.message };
    }

    // 2. Read entire file into buffer
    const fileBuffer = await fs.promises.readFile(filePath);
    const fileSize = fileBuffer.length;
    const fileHash = crypto.createHash('md5').update(fileBuffer).digest('hex');

    log(`[http-upload] Uploading ${fileName}: ${fileSize} bytes (hash: ${fileHash})`);

    // 3. Build headers
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileSize.toString(),
      'x-file-name': fileName,
      'x-agent-name': safeName,
      'x-iso-date': isoDate,
      'x-iso-time': isoTime,
      'x-file-size': fileSize.toString(),
      'x-file-hash': fileHash,
      'x-ffmpeg-repair': shouldRepair ? 'true' : 'false'
    };

    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    // 4. Upload with retries
    let attempt = 0;
    const MAX_ATTEMPTS = 3;
    let lastError = null;

    while (attempt < MAX_ATTEMPTS) {
      try {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * 1000;
          log(`[http-upload] Retrying ${fileName} (attempt ${attempt + 1}/${MAX_ATTEMPTS}) after ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }

        const response = await fetch(config.url, {
          method: 'POST',
          headers,
          body: fileBuffer,
          timeout: 300000 // 5 minutes timeout for large files
        });

        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          log(`[http-upload] Successfully uploaded ${fileName} (${fileSize} bytes)`);
          return { success: true, message: 'upload-complete', size: fileSize, ...result };
        } else {
          const text = await response.text();
          lastError = `HTTP ${response.status}: ${text}`;
          if (response.status === 401) {
            return { success: false, status: 401, error: 'unauthorized' };
          }
        }
      } catch (err) {
        lastError = err.message;
        log(`[http-upload] Upload error:`, err.message);
      }
      attempt++;
    }

    log(`[http-upload] Failed to upload ${fileName} after ${MAX_ATTEMPTS} attempts: ${lastError}`);
    return { success: false, error: 'upload-failed', detail: lastError };
  } catch (error) {
    log(`[http-upload] Fatal error:`, error?.message || error);
    return { success: false, error: error?.message || 'http-upload-failed' };
  }
}

/**
 * Request the recording server to merge all segments for the current user and date.
 * Called automatically when user clocks out.
 */
async function requestSegmentMerge(agentName, date, deleteOriginals = true) {
  const mergeKey = `${agentName}|${date}`;
  const lastCompletedAt = lastCompletedMerge.get(mergeKey);
  if (lastCompletedAt && (Date.now() - lastCompletedAt) < 5 * 60 * 1000) {
    log(`[merge] Skipping duplicate merge request for ${agentName} on ${date} (recently completed)`);
    return { success: false, reason: 'merge-recently-completed' };
  }
  if (activeMergeRequests.has(mergeKey)) {
    log(`[merge] Skipping duplicate merge request for ${agentName} on ${date}`);
    return { success: false, reason: 'merge-already-in-progress' };
  }
  activeMergeRequests.add(mergeKey);

  const config = getHttpUploadConfig();
  if (!config?.url) {
    log('[merge] No HTTP upload URL configured, skipping merge');
    return { success: false, reason: 'http-not-configured' };
  }

  try {
    // Build merge URL from the upload URL (replace /upload with /merge-all)
    const baseUrl = config.url.replace(/\/upload\/?$/, '');
    const mergeUrl = new URL('/merge-all', baseUrl);
    mergeUrl.searchParams.set('agent', agentName);
    mergeUrl.searchParams.set('date', date);
    if (deleteOriginals) {
      mergeUrl.searchParams.set('delete', 'true');
    }

    log(`[merge] Requesting per-screen merge for ${agentName} on ${date}: ${mergeUrl.toString()}`);

    const response = await fetch(mergeUrl.toString(), {
      method: 'GET',
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      timeout: 120000 // 2 minutes for merge operation
    });

    if (response.ok) {
      const result = await response.json();
      log(`[merge] Merge successful:`, result);
      lastCompletedMerge.set(mergeKey, Date.now());
      return { success: true, result };
    } else {
      const errorText = await response.text().catch(() => '');
      log(`[merge] Merge failed: ${response.status} ${errorText}`);
      return { success: false, status: response.status, error: errorText };
    }
    log(`[merge] Merge request error:`, error?.message || error);
    return { success: false, error: error?.message || 'merge-request-failed' };
  } finally {
    activeMergeRequests.delete(mergeKey);
  }
}


function getGoogleSheetTabName() {
  const raw = (cachedAdminSettings?.googleSpreadsheetTabName || "Uploads").trim();
  return raw || "Uploads";
}

function guessRecordingMimeType(fileName = "") {
  const ext = path.extname(fileName || "").toLowerCase();
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".mkv": return "video/x-matroska";
    case ".avi": return "video/x-msvideo";
    default: return "video/webm";
  }
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
    width: 700,
    height: 700,
    minWidth: 700,
    minHeight: 700,
    resizable: true,
    maximizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    icon: APP_ICON
  });

  // Ensure live stream captures and other media requests are auto-approved in the main renderer
  ensureMediaPermissions(mainWindow.webContents);

  // Dev mode should load the local Vite dev server so changes take effect immediately.
  // Production prefers the hosted app (OAuth-friendly) and falls back to the packaged build.
  const hostedUrl = `${APP_BASE_URL}/${DEFAULT_LOGIN_ROUTE_HASH}`;
  const devUrl = process.env.ELECTRON_START_URL || `http://localhost:3000/${DEFAULT_LOGIN_ROUTE_HASH}`;
  const primaryUrl = isDev ? devUrl : hostedUrl;
  const fallbackUrl = isDev ? hostedUrl : null;

  mainWindow.loadURL(primaryUrl).catch(() => {
    if (fallbackUrl) {
      mainWindow.loadURL(fallbackUrl).catch(() => {
        try {
          mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: DEFAULT_LOGIN_ROUTE_HASH });
        } catch (e) {
          log('Failed to load hosted or local app', e?.message || e);
        }
      });
      return;
    }
    try {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: DEFAULT_LOGIN_ROUTE_HASH });
    } catch (e) {
      log('Failed to load hosted or local app', e?.message || e);
    }
  });

  // Send handshake to renderer
  mainWindow.webContents.on("did-finish-load", () => {
    try { mainWindow.webContents.send("desktop-ready", { ok: true }); } catch (e) { }
    // Start watchdog once renderer is loaded.
    startWatchdog();
    startMainLagMonitor();
  });

  // Detect "frozen" renderer and attempt recovery.
  let unresponsiveReloadTimer = null;
  mainWindow.on("unresponsive", () => {
    log("[window] renderer unresponsive");
    recordHealthEvent("window_unresponsive", { note: "mainWindow unresponsive" });
    if (unresponsiveReloadTimer) return;
    unresponsiveReloadTimer = setTimeout(() => {
      unresponsiveReloadTimer = null;
      try {
        // Best-effort recovery: reload the renderer. This keeps the main process alive
        // and often recovers from transient hangs (GPU/JS deadlocks).
        log("[window] attempting reload after unresponsive");
        mainWindow?.webContents?.reload?.();
      } catch (e) {
        log("[window] reload failed", e?.message || e);
      }
    }, 15000);
  });

  mainWindow.on("responsive", () => {
    log("[window] renderer responsive");
    if (unresponsiveReloadTimer) {
      clearTimeout(unresponsiveReloadTimer);
      unresponsiveReloadTimer = null;
    }
    recordHealthEvent("window_responsive", { note: "mainWindow responsive" });
  });

  mainWindow.on("closed", () => {
    stopWatchdog();
    stopMainLagMonitor();
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

  if (!APP_ICON) {
    log('[icon] BrowserWindow is using default icon (APP_ICON missing)');
  }

  registerDevtoolsShortcuts(mainWindow);
}

function createRecorderWindow() {
  try {
    recorderWindow = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, "recorderPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        enableBlinkFeatures: "MediaCapture"
      }
    });
    ensureMediaPermissions(recorderWindow.webContents);
    recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));
    recorderWindow.on('closed', () => { recorderWindow = null; });
  } catch (error) {
    log("[recorderWindow] failed to create", error?.message || error);
  }
}

function startBackgroundRecording() {
  try {
    if (!recorderWindow) createRecorderWindow();
    if (!recorderWindow || recorderWindow.isDestroyed()) {
      // If we can't even reach the recorder window, recording is not actually running.
      isRecordingActive = false;
      if (currentUid) {
        db.collection('agentStatus').doc(currentUid)
          .set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => { });
      }
      return;
    }
    const quality = String(cachedAdminSettings?.recordingQuality || "720p");
    const fps = Number(cachedAdminSettings?.recordingFps || 30);
    recorderWindow.webContents.send('recorder-start', { recordingQuality: quality, recordingFps: fps });
    log('[recorder] start command sent', { quality, fps });
  } catch (error) {
    log('[recorder] failed to start background recording', error?.message || error);
    isRecordingActive = false;
    if (currentUid) {
      db.collection('agentStatus').doc(currentUid)
        .set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true })
        .catch(() => { });
    }
  }
}

function stopBackgroundRecording() {
  try {
    if (!recorderWindow || recorderWindow.isDestroyed()) return;
    recorderWindow.webContents.send('recorder-stop');
  } catch (error) {
    log('[recorder] failed to stop background recording', error?.message || error);
  }
}

function stopBackgroundRecordingAndFlush(options = {}) {
  if (!recorderWindow || recorderWindow.isDestroyed()) return Promise.resolve();
  if (recorderFlushWait) return recorderFlushWait;
  // Default to 60s (was 7s) to handle large 12hr+ recordings roughly 2-5GB
  const timeoutMs = Number.isFinite(options?.timeoutMs) ? options.timeoutMs : 60000;
  const payload = options?.payload || {};
  recorderFlushWait = new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      recorderFlushWait = null;
      resolve();
    };
    const timer = setTimeout(() => {
      log('[recorder] flush timeout');
      done();
    }, timeoutMs);

    const handler = () => {
      clearTimeout(timer);
      ipcMain.removeListener('recorder-flushed', handler);
      done();
    };

    ipcMain.on('recorder-flushed', handler);
    try {
      recorderWindow.webContents.send('recorder-stop-and-flush', payload);
    } catch (err) {
      log('[recorder] failed to request flush', err?.message || err);
      clearTimeout(timer);
      ipcMain.removeListener('recorder-flushed', handler);
      done();
    }
  });
  return recorderFlushWait;
}

// ---------- LOCK WINDOW ----------
// ---------- TRAY ----------
function createTray() {
  try {
    tray = new Tray(APP_ICON || undefined);
    const menu = Menu.buildFromTemplate([
      { label: "Open App", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { label: "Quit", click: () => { isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip("Workforce Desktop");
    tray.setContextMenu(menu);
    tray.on("click", () => { if (mainWindow) mainWindow.show(); });
  } catch (e) {
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
      try { popupWindow.close(); } catch (e) { }
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
        try { popupWindow.close(); } catch (e) { }
        popupWindow = null;
      }
    }, 4000);
  } catch (e) {
    console.error("[electron] showRecordingPopup error", e);
  }
}

function focusMainAppWindow() {
  if (!mainWindow) return;
  try {
    mainWindow.show();
    mainWindow.focus();
  } catch (e) {
    console.warn('[focusMainAppWindow] Failed to focus main window', e?.message || e);
  }
}

function closeManualBreakReminderWindow() {
  if (manualBreakReminderWindow) {
    try {
      manualBreakReminderWindow.removeAllListeners('closed');
      manualBreakReminderWindow.destroy();
    } catch (e) { }
    manualBreakReminderWindow = null;
  }
  manualBreakReminderPayloadKey = null;
}

function showManualBreakReminderPopup(context) {
  if (!context) return;
  const payloadKey = `${context.timeoutMins || 'na'}`;
  if (manualBreakReminderWindow && manualBreakReminderPayloadKey === payloadKey) return;
  manualBreakReminderPayloadKey = payloadKey;
  closeManualBreakReminderWindow();

  try {
    const display = screen.getPrimaryDisplay();
    const { workArea } = display;
    const popupWidth = 480;
    const popupHeight = 260;
    const x = workArea.x + Math.round((workArea.width - popupWidth) / 2);
    const y = workArea.y + Math.round((workArea.height - popupHeight) / 2);

    manualBreakReminderWindow = new BrowserWindow({
      width: popupWidth,
      height: popupHeight,
      x,
      y,
      parent: null,
      modal: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      closable: false,
      focusable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    manualBreakReminderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const durationText = context.timeoutMins === 1 ? '1 minute' : `${context.timeoutMins} minutes`;
    const safeIconUrl = `file://${POPUP_ICON_PATH}`;
    const html = `
      <html>
        <head>
          <meta charset="utf-8"/>
          <style>
            body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial; background: transparent; }
            .card {
              width:100%; height:100%;
              border-radius:20px;
              padding:28px;
              background: linear-gradient(135deg,#991b1b,#7f1d1d);
              color:#fff;
              display:flex;
              flex-direction:column;
              justify-content:space-between;
              box-shadow:0 30px 55px rgba(153,27,27,0.55);
            }
            .header { display:flex; align-items:center; gap:20px; }
            img { width:64px; height:64px; border-radius:14px; background:#fff; padding:8px; box-sizing:border-box; }
            h1 { font-size:22px; margin:0; letter-spacing:0.4px; }
            p { margin:10px 0 0; font-size:15px; color:rgba(255,255,255,0.9); line-height:1.5; }
            .actions { display:flex; flex-direction:column; gap:12px; margin-top:20px; }
            button { padding:14px 18px; border:none; border-radius:12px; font-weight:600; cursor:pointer; font-size:15px; }
            #return { background:#22c55e; color:#052e16; box-shadow:0 12px 28px rgba(34,197,94,0.45); }
            #return:hover { background:#16a34a; }
            #open { background:rgba(255,255,255,0.15); color:#fff; border:1px solid rgba(255,255,255,0.3); }
            #open:hover { background:rgba(255,255,255,0.25); }
          </style>
        </head>
        <body>
          <div class="card">
            <div>
              <div class="header">
                <img src="${safeIconUrl}" alt="Tracker" />
                <div>
                  <h1>Break Time Limit Exceeded</h1>
                  <p>You have been on manual break for more than ${durationText}. Return online to keep tracking your time.</p>
                </div>
              </div>
              <div class="actions">
                <button id="return">Remove Break & Return Online</button>
                <button id="open">Open Tracker</button>
              </div>
            </div>
          </div>
          <script>
            const { ipcRenderer } = require('electron');
            document.getElementById('return').addEventListener('click', () => ipcRenderer.invoke('manual-break-reminder-remove'));
            document.getElementById('open').addEventListener('click', () => ipcRenderer.send('manual-break-reminder-open'));
          </script>
        </body>
      </html>
    `;

    manualBreakReminderWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    manualBreakReminderWindow.on('closed', () => {
      manualBreakReminderWindow = null;
      manualBreakReminderPayloadKey = null;
    });
  } catch (error) {
    console.error('[manual-break-reminder] popup failed', error?.message || error);
  }
}

async function endBreakFromDesktopFlow() {
  if (!currentUid) return { success: false, error: 'no-uid' };
  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('desktop-request-end-break', { uid: currentUid });
      closeManualBreakReminderWindow();
      return { success: true, deliveredToRenderer: true };
    }
  } catch (e) {
    // fall through to server-side update
  }

  try {
    await db.collection('agentStatus').doc(currentUid).set({
      status: 'online',
      manualBreak: false,
      breakStartedAt: FieldValue.delete(),
      isIdle: false,
      lastUpdate: FieldValue.serverTimestamp()
    }, { merge: true }).catch(() => { });

    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('manual-break-cleared-by-desktop', { uid: currentUid });
      }
    } catch (notifyError) {
      console.warn('[manual-break-reminder] failed to notify renderer about cleared break', notifyError?.message || notifyError);
    }
    closeManualBreakReminderWindow();
    return { success: true, deliveredToRenderer: false };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function acknowledgeForceLogoutRequest(uid) {
  if (!uid) return;
  try {
    await db.collection('agentStatus').doc(uid).set({
      forceLogoutRequestId: FieldValue.delete(),
      forceLogoutRequestedAt: FieldValue.delete(),
      forceLogoutCompletedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.warn('[forceLogout] Failed to acknowledge request', error?.message || error);
  }
}

async function handleRemoteForceLogoutRequest(requestId) {
  if (!currentUid || forceLogoutRequestInFlight) return;
  const targetUid = currentUid;
  forceLogoutRequestInFlight = true;
  log('[agentStatusWatch] Force logout request detected', requestId);
  try {
    // Clear the remote request while we're still signed in so it doesn't get stuck.
    await acknowledgeForceLogoutRequest(targetUid);
    await clockOutAndSignOutDesktop('force_logout_remote', { notifyRenderer: true, forceLogoutSource: 'remote_request' });
  } catch (error) {
    console.error('[forceLogout] Failed to process remote request', error?.message || error);
  } finally {
    forceLogoutRequestInFlight = false;
    lastForceLogoutRequestId = null;
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
  // Normalize autoClockOutEnabled to a strict boolean to avoid truthy string issues
  const normalizedAutoClockOutEnabled = next?.autoClockOutEnabled === true;

  cachedAdminSettings = {
    ...next,
    autoClockOutEnabled: normalizedAutoClockOutEnabled
  };
  adminSettingsReady = true;
  log("adminSettings updated:", cachedAdminSettings);
  persistAdminSettingsCache(cachedAdminSettings);

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

  configureGoogleIntegrations();

  if (mainWindow) mainWindow.webContents.send("settings-updated", cachedAdminSettings);

  if (agentClockedIn) {
    const updatedDateKey = toScheduleDateKey();
    if (currentShiftDate !== updatedDateKey) {
      currentShiftDate = updatedDateKey;
      lastAutoClockOutTargetKey = null;
    }
  }

  // Desktop-side auto clock-out has historically caused trouble (unexpected sign-outs, recording stops,
  // and state mismatches). Auto clock-out is enforced server-side via the scheduled Cloud Function.
  // Keep the desktop watcher disabled to avoid conflicting enforcement.
  stopAutoClockOutWatcher();

  restartRecordingSegmentLoop();

}

// ---------- DESKTOP COMMANDS ----------
function startCommandsWatch(uid) {
  if (commandUnsub) { try { commandUnsub(); } catch (e) { } commandUnsub = null; }
  if (!uid) return;

  const docRef = db.collection("desktopCommands").doc(uid);
  commandUnsub = docRef.onSnapshot(async snap => {
    if (!snap.exists) return;
    const cmd = snap.data();
    if (!cmd) return;

    if (cmd.reconnectRequestId) {
      const requestId = String(cmd.reconnectRequestId || '');
      try {
        const tsMs = cmd.timestamp?.toMillis?.()
          ?? cmd.timestamp?.toDate?.()?.getTime?.()
          ?? null;
        const ageMs = tsMs != null ? (Date.now() - tsMs) : 0;
        if (Number.isFinite(ageMs) && ageMs > RECONNECT_TTL_MS) {
          log('[reconnect] ignoring stale reconnect request', { requestId, ageMs });
          await db.collection("desktopCommands").doc(uid).set({
            reconnectRequestId: FieldValue.delete()
          }, { merge: true }).catch(() => { });
          return;
        }
      } catch (_) { }

      log('[reconnect] request received', requestId);
      try {
        await ensureDesktopAuth();
        // Restart watches/loops to recover from a stuck state.
        stopAgentStatusLoop();
        startAgentStatusLoop(uid);
        stopAgentStatusWatch();
        startAgentStatusWatch(uid);
        stopAutoClockConfigWatch();
        startAutoClockConfigWatch(uid);
        await flushPendingAgentStatuses();
        await reassertDesktopStatus(uid);
        await db.collection("agentStatus").doc(uid).set({
          reconnectAckId: requestId,
          reconnectAckAt: FieldValue.serverTimestamp(),
          lastUpdate: FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => { });
      } catch (e) {
        log('[reconnect] failed', e?.message || e);
        await db.collection("agentStatus").doc(uid).set({
          reconnectAckId: requestId,
          reconnectAckAt: FieldValue.serverTimestamp(),
          reconnectError: e?.message || String(e),
          lastUpdate: FieldValue.serverTimestamp()
        }, { merge: true }).catch(() => { });
      } finally {
        await db.collection("desktopCommands").doc(uid).set({
          reconnectRequestId: FieldValue.delete()
        }, { merge: true }).catch(() => { });
      }
    }

    if (cmd.startRecording) {
      log("command startRecording received");
      isRecordingActive = true;
      if (currentUid) await db.collection('agentStatus').doc(currentUid).set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
      showRecordingPopup("Recording started by admin");
      startBackgroundRecording();
      await db.collection("desktopCommands").doc(uid).update({ startRecording: false }).catch(() => { });
    }

    if (cmd.stopRecording) {
      log("command stopRecording received");
      isRecordingActive = false;
      resetAutoResumeRetry();
      if (currentUid) await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
      showRecordingPopup("Recording stopped by admin");
      stopBackgroundRecording();
      await db.collection("desktopCommands").doc(uid).update({ stopRecording: false }).catch(() => { });
    }

    if (cmd.forceLogout) {
      log("command forceLogout received");

      // Online-only policy: ignore stale force-logout commands so users don't have to "log in twice".
      try {
        const tsMs = cmd.timestamp?.toMillis?.()
          ?? cmd.timestamp?.toDate?.()?.getTime?.()
          ?? null;
        const ageMs = tsMs != null ? (Date.now() - tsMs) : Number.POSITIVE_INFINITY;
        if (!Number.isFinite(ageMs) || ageMs > FORCE_LOGOUT_TTL_MS) {
          log("[forceLogout] ignoring stale desktopCommands.forceLogout", { ageMs });
          await db.collection("desktopCommands").doc(uid).set({ forceLogout: false }, { merge: true }).catch(() => { });
          return;
        }
      } catch (_) { }

      // Session targeting: if this command is meant for a different desktop instance, ignore it.
      try {
        const targetSid = cmd.targetDesktopSessionId ? String(cmd.targetDesktopSessionId) : null;
        const thisSid = desktopSessionId ? String(desktopSessionId) : null;
        if (targetSid && thisSid && targetSid !== thisSid) {
          log('[forceLogout] ignoring command targeted to different session', { targetSid, thisSid });
          return;
        }
      } catch (_) {
        // ignore
      }

      // Clear the command immediately while still authenticated; clockOutAndSignOutDesktop signs out.
      await db.collection("desktopCommands").doc(uid).set({ forceLogout: false }, { merge: true }).catch(() => { });
      await clockOutAndSignOutDesktop("force_logout", { notifyRenderer: true });
      return;
    }

    if (cmd.forceBreak) {
      log("force break cmd");
      await db.collection('agentStatus').doc(uid)
        .set({ status: "break", lastUpdate: FieldValue.serverTimestamp() }, { merge: true });
      await db.collection("desktopCommands").doc(uid).update({ forceBreak: false }).catch(() => { });
    }

    if (cmd.bringOnline) {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      await db.collection("desktopCommands").doc(uid).update({ bringOnline: false }).catch(() => { });
    }

    if (cmd.minimizeToTray) {
      if (mainWindow) mainWindow.hide();
      await db.collection("desktopCommands").doc(uid).update({ minimizeToTray: false }).catch(() => { });
    }

    if (typeof cmd.setAutoLaunch !== "undefined") {
      app.setLoginItemSettings({ openAtLogin: !!cmd.setAutoLaunch });
      await db.collection("desktopCommands").doc(uid).update({ setAutoLaunch: FieldValue.delete() }).catch(() => { });
    }
  }, (error) => {
    console.error('[commandsWatch] listener error', error?.message || error);
    recordHealthEvent("firestore_listen_error", { where: "desktopCommands", message: error?.message || String(error) });
    if (isUnauthenticatedError(error)) {
      requestRendererReauth("firestore_unauthenticated_listen_desktopCommands");
    }
  });
}

// Helper to close open screen_lock entries in worklog (used by startAgentStatusLoop and handleScreenUnlock)
async function closeOpenScreenLockEntry(uid) {
  try {
    const worklogsSnap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (!worklogsSnap.empty) {
      const worklogDoc = worklogsSnap.docs[0];
      const worklogData = worklogDoc.data() || {};
      const breaks = Array.isArray(worklogData.breaks) ? worklogData.breaks : [];

      log('[worklog] closeOpenScreenLockEntry found worklog:', worklogDoc.id, 'breaks:', breaks.length);
      let updated = false;
      // Close the last open 'screen_lock' entry
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (breaks[i].cause === 'screen_lock' && !breaks[i].endTime) {
          log('[worklog] Closing open screen_lock entry at index:', i);
          breaks[i] = { ...breaks[i], endTime: Timestamp.now() };
          updated = true;
          // Continued to ensure ALL open duplicate entries are closed
        }
      }

      if (updated) {
        log('[worklog] Committing closed store for screen_lock...');
        await worklogDoc.ref.update({
          breaks,
          lastEventTimestamp: FieldValue.serverTimestamp()
        });
        log('[worklog] Closed open screen_lock entry successfully');
      } else {
        log('[worklog] No open screen_lock entries found to close');
      }
    } else {
      log('[worklog] closeOpenScreenLockEntry: No active worklog found for user:', uid);
    }
  } catch (e) {
    log('[worklog] Failed to close screen_lock entry:', e?.message || e);
  }
}

// Helper to add an idle break entry to the worklog breaks array
async function addIdleBreakEntry(uid) {
  try {
    const worklogsSnap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (!worklogsSnap.empty) {
      const worklogDoc = worklogsSnap.docs[0];
      const worklogData = worklogDoc.data() || {};
      const breaks = Array.isArray(worklogData.breaks) ? worklogData.breaks : [];

      // Check if there's already an open idle entry to prevent duplicates
      const hasOpenIdleEntry = breaks.some(b => b.cause === 'idle' && !b.endTime);
      if (hasOpenIdleEntry) {
        log('[worklog] addIdleBreakEntry: Open idle entry already exists, skipping');
        return;
      }

      log('[worklog] addIdleBreakEntry: Adding idle break entry');

      const idleEntry = {
        startTime: Timestamp.now(),
        endTime: null,
        cause: 'idle',
        isSystemEvent: false  // Idle is a break, not a system event like screen_lock
      };

      await worklogDoc.ref.update({
        breaks: [...breaks, idleEntry],
        lastEventTimestamp: FieldValue.serverTimestamp()
      });

      log('[worklog] addIdleBreakEntry: Added idle break entry successfully');
    } else {
      log('[worklog] addIdleBreakEntry: No active worklog found for user:', uid);
    }
  } catch (e) {
    log('[worklog] Failed to add idle break entry:', e?.message || e);
  }
}

// Helper to close open idle break entry when user becomes active
async function closeOpenIdleEntry(uid) {
  try {
    const worklogsSnap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (!worklogsSnap.empty) {
      const worklogDoc = worklogsSnap.docs[0];
      const worklogData = worklogDoc.data() || {};
      const breaks = Array.isArray(worklogData.breaks) ? worklogData.breaks : [];

      let updated = false;
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (breaks[i].cause === 'idle' && !breaks[i].endTime) {
          log('[worklog] Closing open idle entry at index:', i);
          breaks[i] = { ...breaks[i], endTime: Timestamp.now() };
          updated = true;
        }
      }

      if (updated) {
        await worklogDoc.ref.update({
          breaks,
          lastEventTimestamp: FieldValue.serverTimestamp()
        });
        log('[worklog] Closed open idle entry successfully');
      }
    }
  } catch (e) {
    log('[worklog] Failed to close idle entry:', e?.message || e);
  }
}

// Helper to close open break entry by cause (e.g., away)
async function closeOpenBreakEntry(uid, cause) {
  try {
    const worklogsSnap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (!worklogsSnap.empty) {
      const worklogDoc = worklogsSnap.docs[0];
      const worklogData = worklogDoc.data() || {};
      const breaks = Array.isArray(worklogData.breaks) ? worklogData.breaks : [];

      let updated = false;
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (breaks[i].cause === cause && !breaks[i].endTime) {
          log(`[worklog] Closing open ${cause} entry at index:`, i);
          breaks[i] = { ...breaks[i], endTime: Timestamp.now() };
          updated = true;
        }
      }

      if (updated) {
        await worklogDoc.ref.update({
          breaks,
          lastEventTimestamp: FieldValue.serverTimestamp()
        });
        log(`[worklog] Closed open ${cause} entry successfully`);
      }
    }
  } catch (e) {
    log(`[worklog] Failed to close ${cause} entry:`, e?.message || e);
  }
}

// Atomically transition from screen_lock to idle (close screen_lock and add idle with SAME timestamp)
// This prevents 0-duration working gaps between the two entries
async function transitionScreenLockToIdle(uid) {
  try {
    const worklogsSnap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (!worklogsSnap.empty) {
      const worklogDoc = worklogsSnap.docs[0];
      const worklogData = worklogDoc.data() || {};
      let breaks = Array.isArray(worklogData.breaks) ? [...worklogData.breaks] : [];

      // Use a single timestamp for both operations to prevent gaps
      const transitionTime = Timestamp.now();
      let closedScreenLock = false;

      // Close any open screen_lock entries
      for (let i = breaks.length - 1; i >= 0; i--) {
        if (breaks[i].cause === 'screen_lock' && !breaks[i].endTime) {
          log('[worklog] transitionScreenLockToIdle: Closing screen_lock at index:', i);
          breaks[i] = { ...breaks[i], endTime: transitionTime };
          closedScreenLock = true;
        }
      }

      // Check if idle entry already exists
      const hasOpenIdleEntry = breaks.some(b => b.cause === 'idle' && !b.endTime);

      if (!hasOpenIdleEntry) {
        // Add idle entry with the SAME timestamp as screen_lock close
        const idleEntry = {
          startTime: transitionTime,
          endTime: null,
          cause: 'idle',
          isSystemEvent: false
        };
        breaks.push(idleEntry);
        log('[worklog] transitionScreenLockToIdle: Added idle entry with same timestamp');
      }

      if (closedScreenLock || !hasOpenIdleEntry) {
        await worklogDoc.ref.update({
          breaks,
          lastEventTimestamp: FieldValue.serverTimestamp()
        });
        log('[worklog] transitionScreenLockToIdle: Committed atomic transition');
      }
    } else {
      // No screen_lock was open, just add idle entry
      await addIdleBreakEntry(uid);
    }
  } catch (e) {
    log('[worklog] transitionScreenLockToIdle failed:', e?.message || e);
  }
}

// ---------- STATUS LOOP ----------
function startAgentStatusLoop(uid) {
  if (statusInterval) clearInterval(statusInterval);

  statusInterval = setInterval(async () => {
    if (!uid) return;

    try {
      // If not clocked in → only send heartbeat, no idle logic
      if (!agentClockedIn) {
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

      // If idle timeout is disabled, do nothing (prevents log spam + Firestore reads).
      if (idleLimit <= 0) return;

      const idleSecs = powerMonitor.getSystemIdleTime();
      const timedOutIdle = idleLimit > 0 ? idleSecs >= idleLimit : false;
      const shouldForceIdle = timedOutIdle;
      const idleReason = timedOutIdle ? 'auto_idle' : null;

      // Debug log disabled to reduce console noise
      // console.log("⏱ Idle check → secs:", idleSecs, "limit:", idleLimit, "timedOutIdle:", timedOutIdle, "lastIdleState:", lastIdleState);

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

            if (elapsedMins >= timeoutMins) {
              showManualBreakReminderPopup({ timeoutMins });
            } else {
              closeManualBreakReminderWindow();
            }
          }
        }

        // Do not do idle-driven writes while manual break is active
        return;
      }

      // If screen is locked, keep Away status and do NOT apply idle logic.
      if (isAway) {
        return;
      }

      closeManualBreakReminderWindow();

      // --------------------------
      // Idle detected (idleLimit>0)
      // --------------------------
      if (shouldForceIdle && !lastIdleState) {
        // Atomically close screen_lock and add idle entry with same timestamp
        // This prevents 0-duration working gaps when transitioning from screen_lock to idle
        log("Idle detected - transitioning from screen_lock to idle...");
        await transitionScreenLockToIdle(uid);

        lastIdleState = true;
        log("User idle detected — setting status to break");
        await pushIdleStatus(uid, { idleSecs, reason: idleReason });
        return;
      }

      if (!shouldForceIdle && lastIdleState) {
        lastIdleState = false;
        log("Idle cleared — setting status to online");

        // Close open idle break entry
        await closeOpenIdleEntry(uid);

        if (isAway) {
          log("Idle cleared while locked — setting status to away");
          await pushAwayStatus(uid, { idleSecs });
          return;
        }

        await pushActiveStatus(uid, { idleSecs });
        return;
      }

      // No transition -> do nothing (transitions-only)

    } catch (e) { console.error("[statusLoop] error", e); }
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

async function hydrateClockedInStateFromWorklogs(uid) {
  try {
    if (!uid) return;
    const authed = await ensureDesktopAuth();
    if (!authed) return false;

    // If web already told us the state, don't override it.
    if (agentClockedIn) return true;

    // Best-effort: check if there's any active worklog for this user.
    const snap = await db.collection('worklogs')
      .where('userId', '==', uid)
      .where('status', 'in', ['working', 'on_break', 'break'])
      .limit(1)
      .get();

    if (snap.empty) return false;

    const doc = snap.docs[0];
    const data = doc.data() || {};
    const rawStatus = String(data.status || 'working').toLowerCase();
    const isOnBreak = rawStatus === 'on_break' || rawStatus === 'break';

    agentClockedIn = true;
    startAgentStatusLoop(uid);

    // Start auto-recording only when actively working.
    const safeSettings = cachedAdminSettings || {};
    const allowRecording = safeSettings.allowRecording !== false;
    const recordingMode = safeSettings.recordingMode || 'auto';
    if (!isOnBreak && recordingMode === 'auto' && allowRecording) {
      if (!isRecordingActive) {
        isRecordingActive = true;
        showRecordingPopup('Recording started');
        startBackgroundRecording();
        await db.collection('agentStatus').doc(uid).set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
      }
    }
    return true;
  } catch (e) {
    log('[hydrateClockedInStateFromWorklogs] failed', e?.message || e);
    return false;
  }
}

function startAgentStatusWatch(uid) {
  try {
    stopAgentStatusWatch();
    if (!uid) return;
    lastForceLogoutRequestId = null;
    forceLogoutRequestInFlight = false;
    const docRef = db.collection('agentStatus').doc(uid);
    agentStatusUnsub = docRef.onSnapshot((snap) => {
      if (!snap.exists) return;
      if (snap.metadata?.hasPendingWrites) return; // skip local echoes
      const data = snap.data() || {};

      // Keep local manual-break state in sync without polling Firestore.
      try {
        const nextManualBreak = Boolean(data.manualBreak);
        const startedAtMs = data.breakStartedAt?.toMillis?.()
          ?? data.breakStartedAt?.toDate?.()?.getTime?.()
          ?? null;

        manualBreakActive = nextManualBreak;
        manualBreakStartedAtMs = nextManualBreak && startedAtMs ? startedAtMs : null;
        if (manualBreakActive) {
          scheduleManualBreakReminderIfNeeded();
        } else {
          clearManualBreakReminderTimer();
          closeManualBreakReminderWindow();
        }
      } catch (_) { }

      const remoteForceLogoutRequestId = data.forceLogoutRequestId || null;
      if (remoteForceLogoutRequestId) {
        // Online-only policy: ignore stale force-logout requests.
        try {
          const requestedAtMs = data.forceLogoutRequestedAt?.toMillis?.()
            ?? data.forceLogoutRequestedAt?.toDate?.()?.getTime?.()
            ?? null;
          const ageMs = requestedAtMs != null ? (Date.now() - requestedAtMs) : Number.POSITIVE_INFINITY;
          if (!Number.isFinite(ageMs) || ageMs > FORCE_LOGOUT_TTL_MS) {
            db.collection('agentStatus').doc(uid).set({
              forceLogoutRequestId: FieldValue.delete(),
              forceLogoutRequestedAt: FieldValue.delete(),
              forceLogoutRequestedBy: FieldValue.delete()
            }, { merge: true }).catch(() => { });
            return;
          }
        } catch (_) { }

        // If the request was already completed, just clear the request fields so a user
        // can log back in without getting immediately kicked again.
        try {
          const requestedAtMs = data.forceLogoutRequestedAt?.toMillis?.()
            ?? data.forceLogoutRequestedAt?.toDate?.()?.getTime?.()
            ?? null;
          const completedAtMs = data.forceLogoutCompletedAt?.toMillis?.()
            ?? data.forceLogoutCompletedAt?.toDate?.()?.getTime?.()
            ?? null;
          if (requestedAtMs != null && completedAtMs != null && completedAtMs >= requestedAtMs) {
            db.collection('agentStatus').doc(uid).set({
              forceLogoutRequestId: FieldValue.delete(),
              forceLogoutRequestedAt: FieldValue.delete(),
              forceLogoutRequestedBy: FieldValue.delete()
            }, { merge: true }).catch(() => { });
            return;
          }
        } catch (_) { }

        if (remoteForceLogoutRequestId !== lastForceLogoutRequestId) {
          lastForceLogoutRequestId = remoteForceLogoutRequestId;
          handleRemoteForceLogoutRequest(remoteForceLogoutRequestId).catch((error) => {
            console.error('[agentStatusWatch] Failed to honor force logout request', error?.message || error);
          });
        }
        return;
      }
      lastForceLogoutRequestId = null;

      // IMPORTANT: agentStatus.status is best-effort presence and can be stale/wrong.
      // Do NOT force-stop/clock-out based on it; worklogs + renderer events are the source of truth.
    }, (error) => {
      console.error('[agentStatusWatch] listener error', error?.message || error);
      recordHealthEvent("firestore_listen_error", { where: "agentStatus", message: error?.message || String(error) });
      if (isUnauthenticatedError(error)) {
        requestRendererReauth("firestore_unauthenticated_listen_agentStatus");
      }
      setTimeout(() => startAgentStatusWatch(uid), 5000);
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
      recordHealthEvent("firestore_listen_error", { where: "autoClockConfigs", message: error?.message || String(error) });
      if (isUnauthenticatedError(error)) {
        requestRendererReauth("firestore_unauthenticated_listen_autoClockConfigs");
      }
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
  // Always use organization timezone for auto clock-out calculations
  const timezone = getOrganizationTimezone();
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

  // Only honor per-day slot. If no slot or already past, do nothing.
  if (currentShiftDate) {
    const slot = autoClockSlots?.[currentShiftDate];
    const slotTarget = buildDateFromSlot(slot, currentShiftDate);
    if (slotTarget && now < slotTarget) return slotTarget;
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
        // Guard against stale intervals when the setting is turned off
        if (!cachedAdminSettings?.autoClockOutEnabled) return;
        const target = getAutoClockTargetDate();
        if (!target) return;
        const now = new Date();
        if (now >= target) {
          const key = target.toISOString();
          if (lastAutoClockOutTargetKey === key) return;
          await performAutoClockOut(target);
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

async function performAutoClockOut(shiftEndDate) {
  try {
    if (!currentUid) return;
    if (!cachedAdminSettings?.autoClockOutEnabled) {
      log("[autoClockOut] skipped because setting is disabled");
      return;
    }
    log("[autoClockOut] performing auto clock out for uid:", currentUid);

    const effectiveShiftEnd = shiftEndDate instanceof Date ? shiftEndDate : new Date();
    const shiftEndTs = Timestamp.fromDate(effectiveShiftEnd);

    // Close any active worklogs at the scheduled shift end time
    try {
      const worklogsSnap = await db.collection('worklogs')
        .where('userId', '==', currentUid)
        .where('status', 'in', ['working', 'on_break', 'break'])
        .get();

      if (!worklogsSnap.empty) {
        const updates = worklogsSnap.docs.map(async (docSnap) => {
          const data = docSnap.data() || {};
          const getMillis = (ts) => (ts?.toMillis ? ts.toMillis() : (ts?.toDate ? ts.toDate().getTime() : null));
          const lastEventMillis = getMillis(data.lastEventTimestamp);
          const shiftEndMillis = effectiveShiftEnd.getTime();

          let workDelta = 0;
          let breakDelta = 0;
          if (lastEventMillis != null && shiftEndMillis > lastEventMillis) {
            const elapsedSeconds = (shiftEndMillis - lastEventMillis) / 1000;
            const normalizedStatus = (data.status || 'working').toString().toLowerCase();
            if (normalizedStatus === 'on_break' || normalizedStatus === 'break') {
              breakDelta = elapsedSeconds;
            } else {
              workDelta = elapsedSeconds;
            }
          }

          const payload = {
            status: 'clocked_out',
            clockOutTime: shiftEndTs,
            lastEventTimestamp: shiftEndTs,
            ...(workDelta > 0 ? { totalWorkSeconds: FieldValue.increment(workDelta) } : {}),
            ...(breakDelta > 0 ? { totalBreakSeconds: FieldValue.increment(breakDelta) } : {}),
            activities: (() => {
              const activities = Array.isArray(data.activities) ? data.activities.map(a => ({ ...a })) : [];
              if (activities.length > 0) {
                const last = activities[activities.length - 1];
                if (last && !last.endTime) {
                  activities[activities.length - 1] = { ...last, endTime: shiftEndTs };
                }
              }
              return activities.length ? activities : undefined;
            })(),
            breaks: (() => {
              const breaks = Array.isArray(data.breaks) ? data.breaks.map(b => ({ ...b })) : [];
              if (!breaks.length) return undefined;
              return breaks.map((b) => (b && !b.endTime ? { ...b, endTime: shiftEndTs } : b));
            })()
          };

          // Remove undefined fields so we don't overwrite with undefined
          Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);

          await docSnap.ref.update(payload);
        });

        await Promise.all(updates);
      }
    } catch (e) {
      log("[autoClockOut] Failed to close active worklog(s):", e?.message || e);
    }

    // Stop recording if active
    // Force stop even if isRecordingActive is false (to clean up)
    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    resetAutoResumeRetry();
    await db.collection('agentStatus').doc(currentUid).set({ isRecording: false }, { merge: true }).catch(() => { });
    if (wasRecording) showRecordingPopup("Recording stopped (auto clock-out)");

    // Always send stop command to renderer
    if (mainWindow) mainWindow.webContents.send("command-stop-recording", { uid: currentUid });
    stopBackgroundRecording();

    // mark offline in agentStatus
    await db.collection('agentStatus').doc(currentUid).set({
      status: 'offline',
      isIdle: false,
      lastUpdate: shiftEndTs
    }, { merge: true }).catch(() => { });

    // Keep the user profile in sync on desktop-driven auto clock-out.
    try {
      await db.collection("users").doc(currentUid).set({
        isLoggedIn: false,
        activeSession: FieldValue.delete(),
        lastClockOut: shiftEndTs,
        sessionClearedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      log("[performAutoClockOut] failed to update users.lastClockOut", e?.message || e);
    }

    // inform renderer
    if (mainWindow) mainWindow.webContents.send("auto-clocked-out", { uid: currentUid });

    // ensure renderer clears any locally-stored desktop UID so app won't auto-register on restart
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("clear-desktop-uid");
      }
    } catch (e) { console.warn("[performAutoClockOut] failed to send clear-desktop-uid", e); }

    // optionally: perform any upload logic if you want here (your current Dropbox uploads happen on save)
    // keep currentUid as-is but mark agentClockedIn false
    agentClockedIn = false;
    stopAgentStatusLoop();
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;
    closeManualBreakReminderWindow();

  } catch (e) {
    console.error("[performAutoClockOut] error", e);
  }
}

// ---------- IPC ----------
ipcMain.handle("ping", () => "pong");

ipcMain.handle("report-renderer-error", async (_event, payload = {}) => {
  try {
    await recordHealthEvent("renderer_error", payload || {});
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("sync-admin-settings", async (_event, settings) => {
  try {
    applyAdminSettings(settings || {});

    // Now that settings are known, reconcile recording state (auto mode only).
    try {
      if (currentUid) {
        await reconcileRecordingAfterRegister(currentUid);
      }
    } catch (_) { }
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
    const deviceId = normalized?.deviceId;
    if (!uid) return { success: false, error: "no-uid" };

    if (desktopToken) {
      lastDesktopToken = desktopToken;
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

    const isNewUid = currentUid !== uid;
    currentUid = uid;
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;

    if (isNewUid || !desktopSessionId) {
      desktopSessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

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
    startStatusHealthCheck();
    startRecordingRetryCommandsListener();
    await flushPendingAgentStatuses();

    await reconcileRecordingAfterRegister(uid);
    await reassertDesktopStatus(uid);

    // If the server created an active worklog (mid-shift session switch),
    // make sure this desktop starts behaving like a clocked-in session.
    const hydrated = await hydrateClockedInStateFromWorklogs(uid);
    if (!hydrated) {
      // Handoff worklog might be created by a server trigger moments after login.
      setTimeout(() => {
        if (currentUid === uid) {
          hydrateClockedInStateFromWorklogs(uid).catch(() => { });
        }
      }, 3000);
    }

    // Presence: prefer RTDB (onDisconnect) if enabled, else Firestore heartbeat.
    startRtdbPresence(uid);

    // Publish the active desktop session id so server-side can enforce "single active desktop"
    // and target force-logout to only the previous machine.
    try {
      const sessionPayload = {
        isLoggedIn: true,
        activeDesktopSessionId: desktopSessionId,
        activeDesktopSessionStartedAt: FieldValue.serverTimestamp(),
        activeDesktopMachineName: (() => { try { return require('os').hostname(); } catch { return null; } })(),
        activeDesktopPlatform: process.platform
      };
      if (deviceId) {
        sessionPayload.activeDesktopDeviceId = String(deviceId);
      }
      await db.collection("users").doc(uid).set(sessionPayload, { merge: true });
    } catch (_) {
      // ignore
    }

    setTimeout(() => {
      // best-effort: only retry after the app is fully up and admin settings likely synced.
      // 15s delay helps avoid racing with active recordings starting up.
      retryPendingRecordingUploadsOnLogin().catch(() => { });
    }, 15 * 1000);

    // Upload the latest locally persisted health event (if any) so crashes that couldn't
    // write to Firestore still become visible after the next successful login.
    try {
      if (fs.existsSync(HEALTH_LOG_PATH)) {
        const raw = fs.readFileSync(HEALTH_LOG_PATH, "utf8");
        const lines = raw.trim().split(/\r?\n/).filter(Boolean);
        const last = lines.length ? lines[lines.length - 1] : null;
        if (last) {
          const parsed = JSON.parse(last);
          if (parsed && parsed.type && parsed.message) {
            await writeAgentHealth(uid, {
              lastHealthEventAt: FieldValue.serverTimestamp(),
              lastHealthEventType: String(parsed.type),
              lastHealthEventMessage: String(parsed.message),
              lastHealthEventStack: parsed.stack ? String(parsed.stack) : FieldValue.delete()
            });
          }
        }
      }
    } catch (_) {
      // ignore
    }

    // If a force-logout (desktopCommands/agentStatus) fired during registration,
    // clockOutAndSignOutDesktop() will have cleared currentUid. In that case, do not
    // report a successful registration to the renderer (it will keep queuing statuses,
    // and idle/uploads won't run).
    if (currentUid !== uid) {
      log("[register-uid] aborted (uid cleared during registration)");
      return { success: false, error: "registration-aborted" };
    }

    if (mainWindow) mainWindow.webContents.send("desktop-registered", { uid });
    log("Registered uid:", uid);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("unregister-uid", async () => {
  try {
    if (commandUnsub) { try { commandUnsub(); } catch (e) { } commandUnsub = null; }
    stopAgentStatusLoop();
    stopAgentStatusWatch();
    stopAutoClockConfigWatch();
    stopStatusHealthCheck();
    stopRtdbPresence();
    pendingAgentStatuses.length = 0;
    if (currentUid) {
      await db.collection("agentStatus").doc(currentUid).set({ status: 'offline', lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
    }

    // ensure renderer clears local desktop uid to prevent auto login
    try {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send("clear-desktop-uid");
      }
    } catch (e) { console.warn("[unregister-uid] failed to send clear-desktop-uid", e); }

    currentUid = null;
    agentClockedIn = false;
    isRecordingActive = false;
    resetAutoResumeRetry();
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;
    desktopSessionId = null;
    closeManualBreakReminderWindow();
    try { await clientAuth.signOut(); } catch (signOutErr) { console.warn("[unregister-uid] signOut failed", signOutErr?.message || signOutErr); }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// New IPC: allow web to tell desktop about agent status changes
async function applyAgentStatus(status) {
  if (!currentUid) {
    throw new Error('no-uid');
  }

  const authed = await ensureDesktopAuth();
  if (!authed) {
    log('[applyAgentStatus] auth missing');
    throw new Error('auth-missing');
  }

  log('[applyAgentStatus] received', status, {
    allowRecording: cachedAdminSettings?.allowRecording,
    recordingMode: cachedAdminSettings?.recordingMode,
    isRecordingActive,
    agentClockedIn,
    autoUpload: cachedAdminSettings?.autoUpload
  });

  const writeAgentStatusOrThrow = async (payload, label = "agentStatus_write") => {
    try {
      await db.collection('agentStatus').doc(currentUid).set(payload, { merge: true });
      recordStatusWriteSuccess();
      return true;
    } catch (e) {
      if (isUnauthenticatedError(e)) {
        requestRendererReauth("firestore_unauthenticated_write");
      }
      await recordHealthEvent("agentStatus_write_failed", { label, message: e?.message || String(e) });
      throw e;
    }
  };

  // Accept 'manual_break' from web/renderer when user starts a manual break
  if (status === 'manual_break') {
    agentClockedIn = true;
    manualBreakActive = true;
    manualBreakStartedAtMs = Date.now();
    scheduleManualBreakReminderIfNeeded();

    const wasRecording = isRecordingActive;
    // NOTE: We defer setting isRecordingActive = false until AFTER the flush completes.
    // This allows the lock-screen handler to help if the user locks the screen during flush.

    await writeAgentStatusOrThrow({
      status: 'break',
      manualBreak: true,
      breakStartedAt: FieldValue.serverTimestamp(),
      isIdle: false,
      lastUpdate: FieldValue.serverTimestamp(),
      isRecording: false
    }, "manual_break");

    if (wasRecording) showRecordingPopup('Recording paused (break)');
    await stopBackgroundRecordingAndFlush({ payload: { stopReason: 'manual_break' } });

    // Set flag AFTER flush completes so lock-screen handler can help if needed during flush
    isRecordingActive = false;
    resetAutoResumeRetry();

    try {
      await retryPendingRecordingUploadsOnLogin({ ignoreStability: true, stableForMs: 0 });
    } catch (_) { }

    closeManualBreakReminderWindow();
    return { success: true };
  }

  if (status === 'clocked_out' || status === 'offline') {
    agentClockedIn = false;
    manualBreakActive = false;
    manualBreakStartedAtMs = null;
    clearManualBreakReminderTimer();
    stopAgentStatusLoop();
    currentShiftDate = null;
    lastAutoClockOutTargetKey = null;

    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    resetAutoResumeRetry();

    if (wasRecording) showRecordingPopup('Recording stopped');
    await stopBackgroundRecordingAndFlush({ payload: { stopReason: 'clocked_out' } });
    try {
      await retryPendingRecordingUploadsOnLogin({ ignoreStability: true, stableForMs: 0 });
    } catch (_) { }

    // Auto-merge recording segments on clock-out
    try {
      // Small delay to ensure all uploads have completed
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Fetch user display name from Firestore
      let agentName = 'Unknown';
      try {
        const userDoc = await db.collection('users').doc(currentUid).get();
        if (userDoc.exists) {
          const data = userDoc.data();
          agentName = (data.displayName || data.name || data.email || 'Unknown')
            .replace(/[^a-zA-Z0-9_\-\s]/g, '_')
            .trim();
        }
      } catch (e) {
        log('[merge] Failed to fetch user name:', e?.message);
      }

      // Get today's date in ISO format
      const now = new Date();
      // Use session start date if available (for night shifts), otherwise fallback to current date
      const isoDate = sessionStartIsoDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      // Request merge from recording server
      const mergeResult = await requestSegmentMerge(agentName, isoDate, true);
      if (mergeResult.success) {
        log(`[merge] Segments merged successfully for ${agentName} on ${isoDate}`);
      } else {
        log(`[merge] Segment merge skipped or failed:`, mergeResult.reason || mergeResult.error);
      }
    } catch (mergeErr) {
      log('[merge] Error during auto-merge:', mergeErr?.message || mergeErr);
    }


    await writeAgentStatusOrThrow({
      status: 'offline',
      isIdle: false,
      lastUpdate: FieldValue.serverTimestamp(),
      isRecording: false
    }, "clocked_out");
    return { success: true };
  }

  if (status === 'working' || status === 'online') {
    agentClockedIn = true;
    manualBreakActive = false;
    manualBreakStartedAtMs = null;
    clearManualBreakReminderTimer();
    const dateKey = toScheduleDateKey();
    if (currentShiftDate !== dateKey) {
      currentShiftDate = dateKey;
      lastAutoClockOutTargetKey = null;
    }
    startAgentStatusLoop(currentUid);

    const safeSettings = cachedAdminSettings || {};
    const allowRecording = safeSettings.allowRecording !== false;
    const recordingMode = safeSettings.recordingMode || 'auto';
    log('[applyAgentStatus] working/online branch', { allowRecording, recordingMode, isRecordingActive });

    // When user clocks in, capture the date for merge operations
    if (!sessionStartIsoDate) {
      sessionStartIsoDate = getIsoDateFromMs(Date.now());
    }

    let willRecord = false;
    if (recordingMode === 'auto' && allowRecording) {
      if (!isRecordingActive) {
        isRecordingActive = true;
        showRecordingPopup('Recording started');
        startBackgroundRecording();
        willRecord = true;
        // Immediately set isRecording in Firestore to prevent race conditions with stale statuses
        if (currentUid) {
          db.collection('agentStatus').doc(currentUid).set({
            isRecording: true,
            lastUpdate: FieldValue.serverTimestamp()
          }, { merge: true }).catch(() => { });
        }
      } else {
        log('Online signal received, but recording is already active (ignoring)');
        willRecord = true;
      }
    }

    await writeAgentStatusOrThrow({
      status: 'online',
      isIdle: false,
      lastUpdate: FieldValue.serverTimestamp(),
      manualBreak: false,
      breakStartedAt: FieldValue.delete(),
      isRecording: Boolean(willRecord || isRecordingActive)
    }, "working_online");

    closeManualBreakReminderWindow();
    return { success: true };
  }

  if (status === 'on_break' || status === 'break') {
    agentClockedIn = true;
    manualBreakActive = false;
    manualBreakStartedAtMs = null;
    clearManualBreakReminderTimer();

    const wasRecording = isRecordingActive;
    isRecordingActive = false;
    resetAutoResumeRetry();

    if (wasRecording) showRecordingPopup('Recording paused (break)');
    await stopBackgroundRecordingAndFlush();
    try {
      await retryPendingRecordingUploadsOnLogin({ ignoreStability: true, stableForMs: 0 });
    } catch (_) { }

    await writeAgentStatusOrThrow({
      status: 'break',
      isIdle: true,
      lastUpdate: FieldValue.serverTimestamp(),
      isRecording: false
    }, "break");
    return { success: true };
  }

  return { success: true };
}

async function flushPendingAgentStatuses() {
  if (pendingStatusRetryTimer) {
    clearTimeout(pendingStatusRetryTimer);
    pendingStatusRetryTimer = null;
  }
  if (!currentUid || pendingAgentStatuses.length === 0) return;

  const queued = pendingAgentStatuses.splice(0, pendingAgentStatuses.length);
  const failed = [];

  for (const status of queued) {
    try {
      await applyAgentStatus(status);
    } catch (err) {
      log('Failed to apply queued agent status', status, err?.message || err);
      failed.push(status);
    }
  }

  if (failed.length) {
    pendingAgentStatuses.unshift(...failed);
    schedulePendingStatusFlush();
  }
}

ipcMain.handle("set-agent-status", async (_, status) => {
  try {
    log("set-agent-status received:", status);
    if (!currentUid) {
      log('Desktop not registered yet. Queuing status:', status);
      pendingAgentStatuses.push(status);
      schedulePendingStatusFlush();
      return { success: true, queued: true };
    }

    const result = await applyAgentStatus(status);
    if (result?.success === false) {
      pendingAgentStatuses.push(status);
      schedulePendingStatusFlush();
      return { success: false, queued: true, error: result?.error || "failed" };
    }
    return result;
  } catch (e) {
    log('[set-agent-status] failed, queuing for retry', e?.message || e);
    pendingAgentStatuses.push(status);
    schedulePendingStatusFlush();
    return { success: false, queued: true, error: e.message };
  }
});

// Desktop-initiated end-break helpers
ipcMain.handle('end-break-from-desktop', async () => endBreakFromDesktopFlow());
ipcMain.handle('manual-break-reminder-remove', async () => endBreakFromDesktopFlow());
ipcMain.on('manual-break-reminder-open', () => focusMainAppWindow());

// Recording handlers
ipcMain.handle("start-recording", async () => {
  try {
    if (cachedAdminSettings.allowRecording === false) {
      return { success: false, error: "disabled" };
    }
    // This path is retained for compatibility but now simply starts the background recorder
    isRecordingActive = true;
    if (currentUid) {
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: true, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
    }
    showRecordingPopup("Recording started");
    startBackgroundRecording();
    return { success: true };
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

// Background recorder helper: expose sources to recorder window (avoids missing desktopCapturer in preload)
// Includes retry logic to handle timing issues after wake from sleep or rapid lock/unlock
ipcMain.handle('recorder-get-sources', async () => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (sources && sources.length > 0) {
        return {
          success: true,
          sources: sources.map((s) => ({ id: s.id, name: s.name }))
        };
      }
      // Empty sources array - retry after delay
      if (attempt < MAX_RETRIES) {
        log(`[recorder] get-sources returned empty (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    } catch (error) {
      console.error(`[recorder] get-sources failed (attempt ${attempt}/${MAX_RETRIES})`, error?.message || error);
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        return { success: false, error: error?.message || String(error) };
      }
    }
  }
  // All retries exhausted with empty sources
  log('[recorder] get-sources failed: no sources found after all retries');
  return { success: false, error: 'no-sources-found' };
});

ipcMain.handle("stop-recording", async (_, meta = {}) => {
  try {
    // called by renderer; now forward to background recorder
    isRecordingActive = false;
    autoResumeInFlight = false;
    if (currentUid) {
      await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
    }
    const popupMessage = meta?.autoRetry ? "Recording interrupted. Retrying..." : "Recording stopped";
    showRecordingPopup(popupMessage);
    resetAutoResumeRetry();
    stopBackgroundRecording();
    if (meta?.autoRetry) {
      scheduleAutoResumeRetry(meta?.reason || "renderer-failed");
    }
    log("stop-recording invoked");
    return { success: true };
  } catch (e) {
    console.error("[stop-recording] error", e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle("recorder-failed", async (_event, payload = {}) => {
  log("[recorder] background recorder failed", payload?.error || payload);
  await recordHealthEvent("recorder_failed", payload || {});
  isRecordingActive = false;
  resetAutoResumeRetry();
  if (currentUid) {
    await db.collection('agentStatus').doc(currentUid).set({ isRecording: false, lastUpdate: FieldValue.serverTimestamp() }, { merge: true }).catch(() => { });
  }
  scheduleAutoResumeRetry(payload?.error || "recorder-failed");
  return { success: true };
});

const handleRecordingSaved = async (fileName, arrayBuffer, meta = {}) => {
  const shouldEvaluateAutoResume = Boolean(meta?.isLastSession && !meta?.suppressAutoResume);
  const filePath = path.join(RECORDINGS_DIR, fileName);

  try {
    // 1. ALWAYS write the file to disk first. 
    // This prevents ENOENT if an upload is deferred or retried.
    let buffer = Buffer.from(arrayBuffer);
    const recordingDurationMs = meta?.durationMs || null;

    log("[recorder] Processing save for:", fileName,
      "Size:", buffer.length,
      "DurationMs:", recordingDurationMs,
      "StopReason:", meta?.stopReason || 'unknown'
    );

    // DURATION FIX DISABLED - ts-ebml can't parse incrementally-written WebM files
    // Videos upload correctly and play fine, just show 0:00 duration in some players
    // If duration is critical, fix on the server with FFmpeg after upload
    /*
    try {
      log("[recorder] Fixing WebM duration with ts-ebml...");
      const result = await fixWebmDurationWithTsEbml(buffer);
      buffer = result.buffer;
      if (result.fixed) {
        log("[recorder] ts-ebml duration fix success. Size:", buffer.length);
      } else {
        log("[recorder] ts-ebml duration fix skipped:", result.method, result.error || '');
      }
    } catch (fixErr) {
      log("[recorder] ts-ebml duration fix failed (using original):", fixErr?.message || fixErr);
    }
    */

    await fs.promises.writeFile(filePath, buffer);
    const savedStat = await fs.promises.stat(filePath);
    log("Saved recording to:", filePath, "Final on-disk size:", savedStat.size);


    // 2. NOW check for concurrency. 
    // If another task is already uploading this file, we stop here.
    if (activeUploads.has(fileName)) {
      log(`[recorder] Skip upload for ${fileName} - activity already in progress`);
      return { success: true, skipped: true, reason: 'concurrency-lock' };
    }
    activeUploads.add(fileName);

    const ownerUid = currentUid || meta?.ownerUid || null;
    const ownerName = cachedDisplayName || meta?.ownerName || null;

    // File meta for manifest / retry logic.
    try {
      const stat = fs.statSync(filePath);
      upsertManifestEntry(fileName, { size: stat.size, mtimeMs: stat.mtimeMs, ownerUid, ownerName });
    } catch (_) { }

    // If this file was already fully handled (e.g., delete failed previously), skip work.
    if (isRecordingCompleted(fileName)) {
      try { await fs.promises.unlink(filePath); } catch (_) { }
      return { success: true, skipped: true, reason: 'already-completed' };
    }

    const safeNameSource = ownerName || ownerUid || cachedDisplayName || currentUid || 'unknown';
    const safeName = String(safeNameSource).replace(/[\/:*?"<>|]/g, '-');
    // Use file mtime for stable paths across retries.
    let isoDate = getIsoDateFromMs(Date.now());
    let isoTime = getIsoTimeFromMs(Date.now());
    try {
      const stat = fs.statSync(filePath);
      isoDate = getIsoDateFromMs(stat.mtimeMs);
      isoTime = getIsoTimeFromMs(stat.mtimeMs);
    } catch (_) { }
    const googleDriveFileName = `${safeName}-${isoDate}-${isoTime}-${fileName}`.replace(/[\/:*?"<>|]/g, '-');
    const uploadResults = [];

    const enabledTargets = [];
    if (shouldUploadToDropbox()) enabledTargets.push('dropbox');
    if (shouldUploadToGoogleSheets()) enabledTargets.push('googleSheets');
    if (shouldUploadToHttp()) enabledTargets.push('http');

    log(`[recorder] Upload targets determined for ${fileName}:`, enabledTargets, {
      autoUpload: cachedAdminSettings?.autoUpload,
      dropbox: shouldUploadToDropbox(),
      google: shouldUploadToGoogleSheets(),
      http: shouldUploadToHttp()
    });

    if (enabledTargets.includes('dropbox') && !isTargetUploaded(fileName, 'dropbox')) {
      const dropboxPath = `/recordings/${safeName}/${isoDate}/${isoTime}-${fileName}`;
      log("uploading to Dropbox:", dropboxPath);
      const dropboxResult = await uploadToDropboxWithPath(filePath, dropboxPath);
      uploadResults.push({ target: 'dropbox', path: dropboxPath, ...dropboxResult });
      setTargetUploadResult(fileName, 'dropbox', { success: !!dropboxResult?.success, error: dropboxResult?.error || dropboxResult?.reason || null });
    }

    if (enabledTargets.includes('googleSheets') && !isTargetUploaded(fileName, 'googleSheets')) {
      log("uploading to Google Drive/Sheets:", filePath);
      const googleResult = await uploadRecordingToGoogleTargets({
        filePath,
        fileName,
        safeName,
        isoDate,
        googleFileName: googleDriveFileName
      });
      uploadResults.push({ target: 'googleSheets', ...googleResult });
      setTargetUploadResult(fileName, 'googleSheets', { success: !!googleResult?.success, error: googleResult?.error || googleResult?.reason || null });
    }

    if (enabledTargets.includes('http') && !isTargetUploaded(fileName, 'http')) {
      const httpResult = await uploadToHttpTarget({ filePath, fileName, safeName, isoDate, isoTime });
      uploadResults.push({ target: 'http', ...httpResult });
      setTargetUploadResult(fileName, 'http', { success: !!httpResult?.success, error: httpResult?.error || httpResult?.reason || null });
    }

    if (currentUid && uploadResults.length) {
      const summary = uploadResults.map((entry) => ({
        target: entry.target,
        path: entry.path || null,
        id: entry.meta?.id || entry.meta?.fileId || null,
        success: Boolean(entry.success),
        error: entry.success ? null : (entry.error || entry.reason || null)
      }));
      const overallStatus = summary.every((s) => s.success)
        ? 'ok'
        : (summary.some((s) => s.success) ? 'partial' : 'fail');
      await db.collection("agentStatus").doc(currentUid)
        .set({
          lastUpload: FieldValue.serverTimestamp(),
          lastUploadResult: overallStatus,
          lastUploadDetails: summary
        }, { merge: true });
    }

    // Only delete local file when ALL currently enabled targets have succeeded.
    // This guarantees we can retry failures on next login without duplicating successful uploads.
    const allEnabledSucceeded = enabledTargets.length > 0
      ? enabledTargets.every((t) => isTargetUploaded(fileName, t))
      : uploadResults.some((entry) => entry.success);

    // Log recording events for admin visibility
    for (const result of uploadResults) {
      const downloadUrl = result.meta?.webViewLink || result.meta?.webContentLink ||
        (result.meta?.id ? `https://drive.google.com/file/d/${result.meta.id}/view` : null) ||
        (result.path && result.target === 'dropbox' ? `dropbox:${result.path}` : null);

      await logRecordingEvent({
        userId: ownerUid || currentUid,
        userName: ownerName || cachedDisplayName,
        fileName,
        status: result.success ? 'success' : 'failed',
        uploadTarget: result.target,
        fileSize: buffer?.length || null,
        durationMs: meta?.durationMs || null,
        stopReason: meta?.stopReason || null,
        downloadUrl,
        error: result.success ? null : (result.error || result.reason || 'upload-failed')
      });
    }

    if (allEnabledSucceeded) {
      markRecordingCompleted(fileName);
      try {
        await fs.promises.unlink(filePath);
      } catch (unlinkErr) {
        log("[uploads] failed to delete uploaded file", unlinkErr?.message || unlinkErr);
      }
    }

    return { success: true, filePath, uploads: uploadResults };
  } catch (e) {
    console.error("[notify-recording-saved] error", e);
    return { success: false, error: e.message };
  } finally {
    activeUploads.delete(fileName);
    if (shouldEvaluateAutoResume) {
      scheduleAutoResumeRecording();
    }
  }
};

ipcMain.handle("notify-recording-saved", async (_, fileName, arrayBuffer, meta = {}) => handleRecordingSaved(fileName, arrayBuffer, meta));
ipcMain.handle("recorder-save", async (_event, fileName, arrayBuffer, meta = {}) => handleRecordingSaved(fileName, arrayBuffer, meta));

// ---------- INCREMENTAL RECORDING IPC HANDLERS (for 2GB+ files) ----------
// These handlers support streaming recording chunks directly to disk instead of
// buffering everything in memory. This prevents OOM errors and timeout issues
// for long recordings.

// Active file handles for incremental writes
const activeRecordingHandles = new Map(); // sourceId -> { fd: number, tempPath: string, bytesWritten: number }

// Create a temp file for a recording source and return its path
ipcMain.handle("recorder-create-temp-file", async (_event, sourceId, sourceName) => {
  try {
    const safeName = String(sourceName || 'screen').replace(/[^a-z0-9_\-]/gi, '_');
    const tempFileName = `temp-${safeName}-${Date.now()}.webm`;
    const tempPath = path.join(TEMP_RECORDINGS_DIR, tempFileName);

    // Open file for writing (create if doesn't exist, truncate if exists)
    const fd = fs.openSync(tempPath, 'w');

    activeRecordingHandles.set(sourceId, { fd, tempPath, bytesWritten: 0, sourceName: safeName });
    log(`[recorder] Created temp file for ${sourceId}: ${tempPath}`);

    return { success: true, tempPath };
  } catch (err) {
    log(`[recorder] Failed to create temp file for ${sourceId}:`, err?.message || err);
    return { success: false, error: err?.message || 'create-temp-failed' };
  }
});

// Append a chunk buffer to the temp file (called frequently during recording)
ipcMain.handle("recorder-append-chunk", async (_event, sourceId, chunkBuffer) => {
  try {
    const handle = activeRecordingHandles.get(sourceId);
    if (!handle) {
      // No active handle - might be a stale call, ignore
      return { success: false, error: 'no-active-handle' };
    }

    const buffer = Buffer.from(chunkBuffer);
    fs.writeSync(handle.fd, buffer);
    handle.bytesWritten += buffer.length;

    // Log progress every 10MB
    if (handle.bytesWritten % (10 * 1024 * 1024) < buffer.length) {
      log(`[recorder] ${handle.sourceName}: ${(handle.bytesWritten / (1024 * 1024)).toFixed(1)} MB written`);
    }

    return { success: true, bytesWritten: handle.bytesWritten };
  } catch (err) {
    log(`[recorder] Failed to append chunk for ${sourceId}:`, err?.message || err);
    return { success: false, error: err?.message || 'append-failed' };
  }
});

// Finalize: close file handle, move to recordings folder, trigger upload
ipcMain.handle("recorder-finalize", async (_event, sourceId, meta = {}) => {
  const handle = activeRecordingHandles.get(sourceId);
  if (!handle) {
    log(`[recorder] recorder-finalize: no handle for ${sourceId}`);
    return { success: false, error: 'no-active-handle' };
  }

  try {
    // Close the file descriptor
    fs.closeSync(handle.fd);
    log(`[recorder] Closed temp file for ${sourceId}: ${handle.bytesWritten} bytes`);

    // Generate final filename
    const finalFileName = `recording-${handle.sourceName}-${Date.now()}.webm`;
    const finalPath = path.join(RECORDINGS_DIR, finalFileName);

    // ADD TO ACTIVE UPLOADS IMMEDIATELY to prevent retry mechanism from uploading unfixed file
    // This must happen BEFORE moving the file to the recordings folder
    activeUploads.add(finalFileName);
    log(`[recorder] Reserved upload slot for: ${finalFileName}`);

    // Move from temp to final recordings folder
    await fs.promises.rename(handle.tempPath, finalPath);
    log(`[recorder] Moved recording to: ${finalPath}`);

    // Clean up handle
    activeRecordingHandles.delete(sourceId);

    // Read file stats
    const stat = await fs.promises.stat(finalPath);
    const fileSizeBytes = stat.size;

    // Check if file is valid (not empty)
    if (fileSizeBytes < 1000) {
      log(`[recorder] Warning: Recording file is very small (${fileSizeBytes} bytes)`);
    }

    // Trigger the upload flow (similar to handleRecordingSaved but without the arrayBuffer)
    const shouldEvaluateAutoResume = Boolean(meta?.isLastSession && !meta?.suppressAutoResume);

    try {
      // FFmpeg repair DISABLED - causes delays and errors with incremental WebM files
      /*
      if (durationMs && durationMs > 0) {
        try {
          log("[recorder] Attempting FFmpeg repair on finalized file...");
          const buffer = await fs.promises.readFile(finalPath);
          const result = await repairWebmWithFfmpeg(buffer);
          await fs.promises.writeFile(finalPath, result.buffer);
          if (result.repaired) {
            log("[recorder] FFmpeg repair success. New size:", result.buffer.length);
          } else {
            log("[recorder] FFmpeg repair skipped (file unchanged). Size:", result.buffer.length);
          }
        } catch (fixErr) {
          log("[recorder] FFmpeg repair failed:", fixErr?.message || fixErr);
        }
      }
      */

      // DURATION FIX DISABLED - ts-ebml can't parse incrementally-written WebM files
      // Videos upload correctly and play fine, just show 0:00 duration
      // If duration is critical, fix on the server with FFmpeg after upload
      /*
      try {
        log("[recorder] Fixing incremental WebM duration with ts-ebml...");
        const buffer = await fs.promises.readFile(finalPath);
        const result = await fixWebmDurationWithTsEbml(buffer);
        if (result.fixed) {
          await fs.promises.writeFile(finalPath, result.buffer);
          log("[recorder] ts-ebml duration fix success. Size:", result.buffer.length);
        } else {
          log("[recorder] ts-ebml duration fix skipped:", result.method, result.error || '');
        }
      } catch (fixErr) {
        log("[recorder] ts-ebml duration fix failed (using original):", fixErr?.message || fixErr);
      }
      */

      // NOTE: activeUploads.add(finalFileName) was called earlier, before moving the file
      // This prevents the retry mechanism from picking up the unfixed file

      const ownerUid = currentUid || meta?.ownerUid || null;
      const ownerName = cachedDisplayName || meta?.ownerName || null;

      // Update manifest
      try {
        upsertManifestEntry(finalFileName, { size: fileSizeBytes, mtimeMs: stat.mtimeMs, ownerUid, ownerName });
      } catch (_) { }

      // Check if already completed
      if (isRecordingCompleted(finalFileName)) {
        try { await fs.promises.unlink(finalPath); } catch (_) { }
        activeUploads.delete(finalFileName);
        return { success: true, skipped: true, reason: 'already-completed' };
      }

      // Build upload path
      const safeNameSource = ownerName || ownerUid || cachedDisplayName || currentUid || 'unknown';
      const safeName = String(safeNameSource).replace(/[\/:*?"<>|]/g, '-');
      let isoDate = getIsoDateFromMs(stat.mtimeMs);
      let isoTime = getIsoTimeFromMs(stat.mtimeMs);
      const googleDriveFileName = `${safeName}-${isoDate}-${isoTime}-${finalFileName}`.replace(/[\/:*?"<>|]/g, '-');
      const uploadResults = [];

      // Perform uploads
      const enabledTargets = [];
      if (shouldUploadToDropbox()) enabledTargets.push('dropbox');
      if (shouldUploadToGoogleSheets()) enabledTargets.push('googleSheets');
      if (shouldUploadToHttp()) enabledTargets.push('http');

      log("[recorder] Upload targets:", enabledTargets.length ? enabledTargets.join(', ') : 'none');

      // HTTP upload
      if (shouldUploadToHttp()) {
        try {
          const httpRes = await uploadToHttpTarget({ filePath: finalPath, fileName: finalFileName, safeName, isoDate, isoTime });
          uploadResults.push({ target: 'http', ...(httpRes || {}) });
        } catch (e) {
          uploadResults.push({ target: 'http', success: false, error: e?.message });
        }
      }

      // Dropbox upload
      if (shouldUploadToDropbox()) {
        const dropboxFolder = cachedAdminSettings?.dropboxFolder || "/Recordings";
        const dropboxPath = `${dropboxFolder}/${googleDriveFileName}`;
        try {
          const dbxRes = await uploadToDropboxWithPath(finalPath, dropboxPath);
          uploadResults.push({ target: 'dropbox', ...(dbxRes || {}) });
        } catch (e) {
          uploadResults.push({ target: 'dropbox', success: false, error: e?.message });
        }
      }

      // Google Sheets upload
      if (shouldUploadToGoogleSheets()) {
        try {
          const gsRes = await uploadToGoogleSheets(finalPath, googleDriveFileName, fileSizeBytes);
          uploadResults.push({ target: 'googleSheets', ...(gsRes || {}) });
        } catch (e) {
          uploadResults.push({ target: 'googleSheets', success: false, error: e?.message });
        }
      }

      // If all uploads succeeded, cleanup
      const allSuccess = uploadResults.length === 0 || uploadResults.every(r => r.success);
      if (allSuccess) {
        markRecordingCompleted(finalFileName);
        try { await fs.promises.unlink(finalPath); } catch (_) { }
        log("[recorder] All uploads successful, file deleted:", finalFileName);
      }

      activeUploads.delete(finalFileName);
      if (shouldEvaluateAutoResume) {
        scheduleAutoResumeRecording();
      }

      return { success: true, filePath: finalPath, uploads: uploadResults };

    } catch (uploadErr) {
      log("[recorder] Upload error:", uploadErr?.message || uploadErr);
      activeUploads.delete(finalFileName);
      if (shouldEvaluateAutoResume) {
        scheduleAutoResumeRecording();
      }
      return { success: false, error: uploadErr?.message, filePath: finalPath };
    }

  } catch (err) {
    log(`[recorder] Failed to finalize ${sourceId}:`, err?.message || err);
    activeRecordingHandles.delete(sourceId);
    return { success: false, error: err?.message || 'finalize-failed' };
  }
});

// Cleanup any orphaned temp files on startup
function cleanupOrphanedTempRecordings() {
  try {
    if (!fs.existsSync(TEMP_RECORDINGS_DIR)) return;
    const entries = fs.readdirSync(TEMP_RECORDINGS_DIR);
    for (const name of entries) {
      try {
        const fullPath = path.join(TEMP_RECORDINGS_DIR, name);
        fs.unlinkSync(fullPath);
        log(`[recorder] Cleaned up orphaned temp file: ${name}`);
      } catch (_) { }
    }
  } catch (err) {
    log("[recorder] Failed to cleanup temp recordings:", err?.message || err);
  }
}
cleanupOrphanedTempRecordings();


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
    await clockOutAndSignOutDesktop("clocked_out_and_signed_out", { notifyRenderer: true });
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
  } catch (e) {
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
      // Dev builds don't support auto updates; avoid showing an "error" toast in the UI.
      emitAutoUpdateStatus("up-to-date", { message: "Auto updates disabled in dev mode" });
      return { success: true, skipped: true };
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
        .catch(() => { });
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

    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: "missing-file" };
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    // Use overwrite so retries (or crash-before-manifest) do not create duplicate files.
    const arg = { path: dropboxPath, mode: "overwrite", autorename: false };

    const callDropboxUpload = async (token) => {
      const controller = new AbortController();
      const timeoutMs = 10 * 60 * 1000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const contentStream = fs.createReadStream(filePath);
        const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Dropbox-API-Arg": JSON.stringify(arg),
            "Content-Type": "application/octet-stream",
            "Content-Length": String(fileSize)
          },
          body: contentStream,
          signal: controller.signal
        });
        return response;
      } finally {
        clearTimeout(timeout);
      }
    };

    const parseDropboxResponse = async (response) => {
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (parseErr) {
        parsed = { raw, parseError: parseErr?.message || "invalid-json" };
      }

      return { response, body: parsed };
    };

    const callUploadSessionStart = async (token, chunk) => {
      const res = await fetch("https://content.dropboxapi.com/2/files/upload_session/start", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Dropbox-API-Arg": JSON.stringify({ close: false }),
          "Content-Type": "application/octet-stream"
        },
        body: chunk
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      return { res, json };
    };

    const callUploadSessionAppend = async (token, sessionId, offset, chunk) => {
      const res = await fetch("https://content.dropboxapi.com/2/files/upload_session/append_v2", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Dropbox-API-Arg": JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
          "Content-Type": "application/octet-stream"
        },
        body: chunk
      });
      return res;
    };

    const callUploadSessionFinish = async (token, sessionId, offset) => {
      const res = await fetch("https://content.dropboxapi.com/2/files/upload_session/finish", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Dropbox-API-Arg": JSON.stringify({
            cursor: { session_id: sessionId, offset },
            commit: { path: dropboxPath, mode: "overwrite", autorename: false }
          }),
          "Content-Type": "application/octet-stream"
        },
        body: "" // empty body per API
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      return { res, json };
    };

    // Small files: simple upload
    if (fileSize <= DROPBOX_SIMPLE_UPLOAD_LIMIT) {
      let response = await callDropboxUpload(validToken);
      let { body } = await parseDropboxResponse(response);

      if (response.status === 401) {
        log("[dropbox] got 401, attempting token refresh");
        const newToken = await refreshDropboxToken();
        if (newToken) {
          response = await callDropboxUpload(newToken);
          ({ body } = await parseDropboxResponse(response));
        }
      }

      if (!response.ok) {
        log("[dropbox] upload failed", response.status, body);
        return { success: false, error: body || { status: response.status } };
      }

      try {
        log("[dropbox] upload ok", { path: body?.path_display || dropboxPath, id: body?.id || null });
      } catch (_) { }
      return { success: true, meta: body };
    }

    // Large files: chunked upload session
    const stream = fs.createReadStream(filePath, { highWaterMark: DROPBOX_CHUNK_SIZE });
    let sessionId = null;
    let offset = 0;
    const tokenToUse = validToken;

    for await (const chunk of stream) {
      if (!sessionId) {
        const { res, json } = await callUploadSessionStart(tokenToUse, chunk);
        if (!res.ok || !json?.session_id) {
          log("[dropbox] session start failed", res.status, json);
          return { success: false, error: json || { status: res.status } };
        }
        sessionId = json.session_id;
        offset += chunk.length;
      } else {
        const res = await callUploadSessionAppend(tokenToUse, sessionId, offset, chunk);
        if (!res.ok) {
          const text = await res.text();
          log("[dropbox] session append failed", res.status, text);
          return { success: false, error: text || { status: res.status } };
        }
        offset += chunk.length;
      }
    }

    const { res: finishRes, json: finishJson } = await callUploadSessionFinish(tokenToUse, sessionId, offset);
    if (!finishRes.ok) {
      log("[dropbox] session finish failed", finishRes.status, finishJson);
      return { success: false, error: finishJson || { status: finishRes.status } };
    }

    try {
      log("[dropbox] chunked upload ok", { path: finishJson?.path_display || dropboxPath, id: finishJson?.id || null });
    } catch (_) { }
    return { success: true, meta: finishJson };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function uploadRecordingToGoogleTargets(context = {}) {
  try {
    if (!shouldUploadToGoogleSheets()) {
      return { success: false, skipped: true, reason: googleSetupError || "google-disabled" };
    }

    await ensureGoogleAuthorized();

    const filePath = context.filePath;
    const originalFileName = context.fileName;
    const driveFileName = context.googleFileName || originalFileName;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("missing-file");
    }

    const parents = [];
    if (cachedAdminSettings?.googleDriveFolderId) {
      parents.push(cachedAdminSettings.googleDriveFolderId.trim());
    }

    const driveResult = await googleDriveClient.files.create({
      requestBody: {
        name: driveFileName,
        parents: parents.length ? parents : undefined
      },
      media: {
        mimeType: guessRecordingMimeType(driveFileName || filePath),
        body: fs.createReadStream(filePath)
      },
      fields: "id,name,webViewLink,webContentLink",
      uploadType: "resumable"
    });

    const fileId = driveResult?.data?.id || null;
    const fileUrl = driveResult?.data?.webViewLink
      || driveResult?.data?.webContentLink
      || (fileId ? `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk` : null);

    const tabName = getGoogleSheetTabName().replace(/'/g, "''");
    const rowValues = [[
      new Date().toISOString(),
      context.safeName || currentUid || 'unknown',
      originalFileName || driveFileName,
      context.isoDate || '',
      fileUrl || '',
      fileId || '',
      os.hostname()
    ]];

    await googleSheetsClient.spreadsheets.values.append({
      spreadsheetId: cachedAdminSettings.googleSpreadsheetId,
      range: `'${tabName}'!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rowValues }
    });

    return { success: true, fileId, fileUrl };
  } catch (error) {
    log("[google] Upload failed", error?.message || error);
    return { success: false, error: error?.message || String(error) };
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
    autoUpdater.checkForUpdates().catch((error) => {
      emitAutoUpdateStatus("error", { message: error?.message || String(error) });
    });
  }, isNaN(delay) ? 3000 : delay);
}

// ---------- APP INIT ----------
app.whenReady().then(() => {
  createRecorderWindow();
  createMainWindow();
  createTray();
  buildAppMenu();

  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  const handleSystemRecordingFlush = async (reason) => {
    // Also help if there's a flush in progress (e.g., manual break started but screen locked before flush finished)
    if (!isRecordingActive && !recorderFlushWait) return;
    log(`[system] ${reason} detected; stopping recorder for flush`);
    try {
      await stopBackgroundRecordingAndFlush({
        timeoutMs: 45000, // 45s (was 3s) - ample time for large file save before lock/suspend limits
        payload: { suppressAutoResume: true, stopReason: reason }
      });
      isRecordingActive = false; // Ensure flag is reset so it can resume on unlock
    } catch (_) { }
    try {
      await retryPendingRecordingUploadsOnLogin({ ignoreStability: true, stableForMs: 0 });
    } catch (_) { }
  };

  // Guard to prevent concurrent handleScreenLock executions (Windows can fire lock event multiple times)
  let screenLockInFlight = false;

  // Handle Away status when screen is locked/unlocked
  const handleScreenLock = async () => {
    if (isAway) return; // Prevent duplicate lock events
    if (screenLockInFlight) {
      log('[away] handleScreenLock already in flight, skipping duplicate event');
      return;
    }
    screenLockInFlight = true;

    try {
      isAway = true;

      handleSystemRecordingFlush('lock-screen');

      // Only set Away status if user is clocked in and working
      if (!currentUid || !agentClockedIn || manualBreakActive) return;

      log('[away] Screen locked - setting Away status');

      try {
        await db.collection('agentStatus').doc(currentUid).set({
          status: 'away',
          isAway: true,
          awayReason: 'screen_lock',
          awayStartedAt: FieldValue.serverTimestamp(),
          lastUpdate: FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) {
        log('[away] Failed to set Away status:', e?.message || e);
      }

      // Add away break entry to the active worklog for activity logs
      // Uses TRANSACTION to prevent race conditions and duplicate entries
      try {
        log('[away] Attempting transactional away break write...');

        // Close any open idle entry to prevent overlap
        await closeOpenIdleEntry(currentUid);

        // 1. Find the active worklog (Query outside transaction first)
        // Client SDK transactions cannot run queries, only get(docRef).
        const worklogsRef = db.collection('worklogs');
        const q = worklogsRef
          .where('userId', '==', currentUid)
          .where('status', 'in', ['working', 'on_break', 'break'])
          .limit(1);

        const worklogsSnap = await q.get();

        if (worklogsSnap.empty) {
          log('[away] No active worklog found to add screen_lock');
          return;
        }

        const activeDocRef = worklogsSnap.docs[0].ref;

        await db.runTransaction(async (transaction) => {
          // 2. Re-read the doc inside the transaction for consistency
          const worklogDoc = await transaction.get(activeDocRef);

          if (!worklogDoc.exists) {
            throw "Worklog document disappeared";
          }

          const worklogData = worklogDoc.data() || {};

          // Ensure it's still active (in case it closed since the query)
          const currentStatus = worklogData.status;
          if (!['working', 'on_break', 'break'].includes(currentStatus)) {
            log('[away] Worklog no longer active inside transaction. Aborting.');
            return;
          }

          const existingBreaks = Array.isArray(worklogData.breaks) ? worklogData.breaks : [];

          // 3. SAFETY: Strict Deduplication inside Transaction
          if (existingBreaks.length > 0) {
            const last = existingBreaks[existingBreaks.length - 1];
            if (last.cause === 'away' && !last.endTime) {
              log('[away] Transaction aborted: away break already exists');
              return;
            }
          }

          log('[away] Transaction: Found worklog', worklogDoc.id, 'adding away break');

          // 4. Add new away break entry
          const newEntry = {
            startTime: Timestamp.now(),
            endTime: null,
            cause: 'away',
            isSystemEvent: false
          };

          transaction.update(activeDocRef, {
            breaks: [...existingBreaks, newEntry],
            lastEventTimestamp: FieldValue.serverTimestamp()
          });
        });

        log('[away] Transaction committed successfully');
      } catch (e) {
        log('[away] Failed to add away break (transaction failed):', e?.message || e);
      }
    } finally {
      screenLockInFlight = false;
    }
  };

  const handleScreenUnlock = async () => {
    // Only clear Away status if we were away due to screen lock
    if (!currentUid || !isAway) return;

    isAway = false;
    log('[away] Screen unlocked - restoring online status');

    try {
      await db.collection('agentStatus').doc(currentUid).set({
        status: 'online',
        isAway: false,
        isIdle: false,
        awayReason: FieldValue.delete(),
        awayStartedAt: FieldValue.delete(),
        idleReason: FieldValue.delete(),
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      log('[away] Failed to clear Away status:', e?.message || e);
    }

    // Close any open away/idle entries in the worklog
    await closeOpenBreakEntry(currentUid, 'away');
    await closeOpenIdleEntry(currentUid);

    // Resume recording if needed after unlock
    if (agentClockedIn && !manualBreakActive) {
      await resumeRecordingIfNeeded(currentUid);
    }
  };

  try {
    powerMonitor.on('lock-screen', () => { handleScreenLock(); });
    powerMonitor.on('unlock-screen', () => { handleScreenUnlock(); });
    powerMonitor.on('suspend', () => { handleSystemRecordingFlush('suspend'); });
    powerMonitor.on('shutdown', () => { handleSystemRecordingFlush('shutdown'); });
  } catch (_) { }

  startRecordingSegmentLoop();
  startUploadRetryLoop();
  startRecordingRetryCommandsListener();

  scheduleAutoUpdateCheck();
});

app.on("before-quit", async () => {
  isQuiting = true;
  try {
    if (currentUid) {
      await setRtdbPresenceOfflineIfSessionMatches(currentUid);
    }
  } catch (_) { }
  try {
    await stopBackgroundRecordingAndFlush();
  } catch (err) {
    log('[recorder] flush on quit failed', err?.message || err);
  }
});

app.on("will-quit", () => {
  globalShortcut.unregister("CommandOrControl+Shift+I");
  globalShortcut.unregister("F12");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
