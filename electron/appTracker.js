/**
 * App & Website Tracking Module
 * 
 * Tracks foreground applications and browser page titles.
 * - Stores spans in memory during the shift
 * - Updates RTDB for real-time dashboard
 * - Backs up to local JSON every 5 min
 * - Flushes a single summary to Firestore at clock-out
 */

const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

// Try to load active-win (v8, CJS-compatible)
let activeWin = null;
try {
    activeWin = require('active-win');
} catch (e) {
    console.log('[app-tracker] active-win not available:', e.message);
}

const APP_TRACKER_BACKUP_PATH = path.join(app.getPath('userData'), 'appActivity.json');

// --- Built-in Category Rules ---
const BUILTIN_CATEGORY_RULES = [
    // Development
    { type: 'app', pattern: 'code', category: 'development' },
    { type: 'app', pattern: 'visual studio', category: 'development' },
    { type: 'app', pattern: 'intellij', category: 'development' },
    { type: 'app', pattern: 'webstorm', category: 'development' },
    { type: 'app', pattern: 'pycharm', category: 'development' },
    { type: 'app', pattern: 'android studio', category: 'development' },
    { type: 'app', pattern: 'terminal', category: 'development' },
    { type: 'app', pattern: 'cmd.exe', category: 'development' },
    { type: 'app', pattern: 'powershell', category: 'development' },
    { type: 'app', pattern: 'git', category: 'development' },
    { type: 'app', pattern: 'postman', category: 'development' },
    { type: 'app', pattern: 'docker', category: 'development' },
    { type: 'app', pattern: 'sublime', category: 'development' },
    { type: 'app', pattern: 'notepad++', category: 'development' },
    { type: 'title', pattern: 'github', category: 'development' },
    { type: 'title', pattern: 'gitlab', category: 'development' },
    { type: 'title', pattern: 'bitbucket', category: 'development' },
    { type: 'title', pattern: 'stack overflow', category: 'development' },
    { type: 'title', pattern: 'stackoverflow', category: 'development' },
    // Productive
    { type: 'app', pattern: 'winword', category: 'productive' },
    { type: 'app', pattern: 'excel', category: 'productive' },
    { type: 'app', pattern: 'powerpnt', category: 'productive' },
    { type: 'app', pattern: 'onenote', category: 'productive' },
    { type: 'title', pattern: 'google docs', category: 'productive' },
    { type: 'title', pattern: 'google sheets', category: 'productive' },
    { type: 'title', pattern: 'google slides', category: 'productive' },
    { type: 'title', pattern: 'notion', category: 'productive' },
    { type: 'title', pattern: 'jira', category: 'productive' },
    { type: 'title', pattern: 'trello', category: 'productive' },
    { type: 'title', pattern: 'asana', category: 'productive' },
    { type: 'title', pattern: 'monday.com', category: 'productive' },
    { type: 'title', pattern: 'confluence', category: 'productive' },
    // Communication
    { type: 'app', pattern: 'slack', category: 'communication' },
    { type: 'app', pattern: 'teams', category: 'communication' },
    { type: 'app', pattern: 'discord', category: 'communication' },
    { type: 'app', pattern: 'zoom', category: 'communication' },
    { type: 'app', pattern: 'thunderbird', category: 'communication' },
    { type: 'app', pattern: 'outlook', category: 'communication' },
    { type: 'title', pattern: 'google meet', category: 'communication' },
    { type: 'title', pattern: 'gmail', category: 'communication' },
    { type: 'title', pattern: 'outlook', category: 'communication' },
    { type: 'title', pattern: 'whatsapp', category: 'communication' },
    // Social
    { type: 'title', pattern: 'facebook', category: 'social' },
    { type: 'title', pattern: 'twitter', category: 'social' },
    { type: 'title', pattern: '/ x', category: 'social' },
    { type: 'title', pattern: 'instagram', category: 'social' },
    { type: 'title', pattern: 'linkedin', category: 'social' },
    { type: 'title', pattern: 'reddit', category: 'social' },
    { type: 'title', pattern: 'tiktok', category: 'social' },
    // Entertainment
    { type: 'title', pattern: 'youtube', category: 'entertainment' },
    { type: 'title', pattern: 'netflix', category: 'entertainment' },
    { type: 'app', pattern: 'spotify', category: 'entertainment' },
    { type: 'title', pattern: 'twitch', category: 'entertainment' },
    { type: 'app', pattern: 'steam', category: 'entertainment' },
    { type: 'title', pattern: 'disney+', category: 'entertainment' },
    { type: 'title', pattern: 'prime video', category: 'entertainment' },
    // Design
    { type: 'app', pattern: 'photoshop', category: 'design' },
    { type: 'app', pattern: 'illustrator', category: 'design' },
    { type: 'app', pattern: 'figma', category: 'design' },
    { type: 'title', pattern: 'figma', category: 'design' },
    { type: 'app', pattern: 'sketch', category: 'design' },
    { type: 'title', pattern: 'canva', category: 'design' },
    { type: 'app', pattern: 'gimp', category: 'design' },
];

const BROWSER_NAMES_RE = /^(.+?)\s*[-\u2013\u2014]\s*(Google Chrome|Mozilla Firefox|Microsoft Edge|Opera|Brave|Vivaldi|Safari)\s*$/i;

// --- State ---
let pollInterval = null;
let backupInterval = null;
let spans = [];
let currentSpan = null;
let paused = false;
let flushInFlight = null;
let backupRecovered = false;
let lastWindowFingerprint = '';
let idleAvoidState = {
    active: false,
    startedAt: 0,
    lastTriggerAt: 0,
    alertSent: false,
    reason: null,
};
let lowIdleSameWindowStartedAt = 0;
let lowIdleSameWindowFingerprint = '';
// Strict idle-avoid detection defaults to reduce false positives during real typing:
// require uninterrupted zero-idle streak on the same exact window.
const DEFAULT_IDLE_AVOID_HELD_ACTIVITY_MS = 120000;
const IDLE_AVOID_MAX_SECS_DURING_STREAK = 0;
const MIN_IDLE_AVOID_DURATION_SECONDS = 30;
const MAX_IDLE_AVOID_DURATION_SECONDS = 600;

// These are injected from main.js via init()
let ctx = {
    log: console.log,
    getUid: () => null,
    getDateKey: () => new Date().toISOString().slice(0, 10),
    isClockedIn: () => false,
    isOnBreak: () => false,
    isIdle: () => false,
    getIdleSeconds: () => 0,
    isScreenLocked: () => false,
    getAdminSettings: () => ({}),
    getMainWindow: () => null,
    getRtdb: () => null,
    getDb: () => null,
    ensureAuth: async () => false,
};

function getTrackingDateKey() {
    try {
        const key = ctx.getDateKey ? ctx.getDateKey() : null;
        if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
    } catch (_) { }
    return new Date().toISOString().slice(0, 10);
}

// --- Classification ---
function classifyApp(appName, title) {
    const appLower = (appName || '').toLowerCase();
    const titleLower = (title || '').toLowerCase();

    // Admin-defined rules take priority
    const adminRules = ctx.getAdminSettings()?.appCategoryRules || [];
    for (const rule of adminRules) {
        const target = rule.type === 'app' ? appLower : titleLower;
        if (target.includes(rule.pattern.toLowerCase())) return rule.category;
    }

    // Built-in rules
    for (const rule of BUILTIN_CATEGORY_RULES) {
        const target = rule.type === 'app' ? appLower : titleLower;
        if (target.includes(rule.pattern.toLowerCase())) return rule.category;
    }

    return 'uncategorized';
}

function parseBrowserTitle(rawTitle) {
    const match = BROWSER_NAMES_RE.exec(rawTitle || '');
    return match ? match[1].trim() : (rawTitle || '');
}

function isBrowserApp(appName) {
    const lower = (appName || '').toLowerCase();
    return ['chrome', 'firefox', 'msedge', 'edge', 'opera', 'brave', 'vivaldi', 'safari', 'browser']
        .some(b => lower.includes(b));
}

function nowMs() {
    return Date.now();
}

function resetIdleAvoidState() {
    idleAvoidState = {
        active: false,
        startedAt: 0,
        lastTriggerAt: 0,
        alertSent: false,
        reason: null,
    };
    lowIdleSameWindowStartedAt = 0;
    lowIdleSameWindowFingerprint = '';
}

function getIdleAvoidConfig(settings = {}) {
    const enabled = settings?.idleAvoidEnabled !== false;
    const rawDurationSeconds = Number(settings?.idleAvoidDurationSeconds);
    let durationSeconds = Math.round(DEFAULT_IDLE_AVOID_HELD_ACTIVITY_MS / 1000);
    if (Number.isFinite(rawDurationSeconds)) {
        durationSeconds = Math.max(
            MIN_IDLE_AVOID_DURATION_SECONDS,
            Math.min(MAX_IDLE_AVOID_DURATION_SECONDS, Math.round(rawDurationSeconds))
        );
    }
    return {
        enabled,
        durationSeconds,
        durationMs: durationSeconds * 1000,
    };
}

function evaluateIdleAvoidDetection({ appName, pageTitle, idleSecs, idleLimit, now, idleAvoidConfig }) {
    const fingerprint = `${String(appName || '').toLowerCase()}||${String(pageTitle || '').toLowerCase()}`;
    const sameWindow = fingerprint === lastWindowFingerprint;

    if (!idleAvoidConfig?.enabled) {
        if (idleAvoidState.active || lowIdleSameWindowStartedAt) {
            resetIdleAvoidState();
        }
        lastWindowFingerprint = fingerprint;
        return false;
    }

    if (!sameWindow) {
        lowIdleSameWindowStartedAt = 0;
        lowIdleSameWindowFingerprint = '';
        if (idleAvoidState.active) {
            idleAvoidState.active = false;
            idleAvoidState.reason = null;
        }
    }

    // Secondary heuristic: suspicious constant zero-idle while staying on the exact same window/title.
    // This is intentionally strict to avoid firing during normal multi-key keyboard activity.
    if (sameWindow && idleLimit >= 30) {
        if (idleSecs <= IDLE_AVOID_MAX_SECS_DURING_STREAK) {
            if (lowIdleSameWindowFingerprint !== fingerprint || !lowIdleSameWindowStartedAt) {
                lowIdleSameWindowFingerprint = fingerprint;
                lowIdleSameWindowStartedAt = now;
            }
        } else {
            lowIdleSameWindowStartedAt = 0;
            lowIdleSameWindowFingerprint = '';
        }
    } else {
        lowIdleSameWindowStartedAt = 0;
        lowIdleSameWindowFingerprint = '';
    }

    // If window never changed and idle stays near-zero for 2+ minutes, treat as idle-avoid.
    if (!idleAvoidState.active && lowIdleSameWindowStartedAt) {
        const lowIdleDurationMs = now - lowIdleSameWindowStartedAt;
        // Rule 1: sustained zero-idle streak (likely keep-alive) for configured duration.
        if (lowIdleDurationMs >= idleAvoidConfig.durationMs) {
            idleAvoidState.active = true;
            idleAvoidState.startedAt = lowIdleSameWindowStartedAt;
            idleAvoidState.lastTriggerAt = now;
            idleAvoidState.alertSent = false;
            idleAvoidState.reason = `sustained-zero-idle-${idleAvoidConfig.durationSeconds}s`;
            ctx.log('[app-tracker] idle-avoid sustained input detected');
        }
    }

    if (idleAvoidState.active) {
        const staleForMs = now - (idleAvoidState.lastTriggerAt || idleAvoidState.startedAt || now);
        if (!sameWindow || staleForMs > Math.max(90000, idleLimit * 2000)) {
            idleAvoidState.active = false;
            idleAvoidState.reason = null;
        }
    }

    lastWindowFingerprint = fingerprint;
    return idleAvoidState.active;
}

async function writeAppAlert(payload) {
    try {
        const firestoreDb = ctx.getDb();
        if (!firestoreDb) return false;
        const uid = ctx.getUid();
        await firestoreDb.collection('appAlerts').add({
            userId: uid,
            userDisplayName: ctx.getUserDisplayName ? ctx.getUserDisplayName() : uid,
            teamId: ctx.getUserTeamId ? ctx.getUserTeamId() : null,
            timestamp: nowMs(),
            ...payload,
        });
        return true;
    } catch (e) {
        ctx.log('[app-tracker] app alert write failed:', e?.message || e);
        return false;
    }
}

// --- Polling ---
async function tick() {
    if (!activeWin || !ctx.getUid() || !ctx.isClockedIn() || paused) return;
    if (ctx.isOnBreak && ctx.isOnBreak()) return;
    if (ctx.isIdle() || ctx.isScreenLocked()) return;

    try {
        const win = await activeWin();
        if (!win) return;

        const appName = win.owner?.name || win.owner?.path?.split(/[/\\]/).pop() || 'Unknown';
        const rawTitle = win.title || '';
        const browser = isBrowserApp(appName);
        const pageTitle = browser ? parseBrowserTitle(rawTitle) : rawTitle;
        const realCategory = classifyApp(appName, rawTitle);
        const now = nowMs();
        const settings = ctx.getAdminSettings() || {};
        const idleLimit = Math.max(0, Number(settings?.idleTimeout) || 0);
        const idleSecs = Number(ctx.getIdleSeconds?.() ?? 0);
        const idleAvoidConfig = getIdleAvoidConfig(settings);
        const idleAvoidActive = evaluateIdleAvoidDetection({ appName, pageTitle, idleSecs, idleLimit, now, idleAvoidConfig });

        const effectiveApp = idleAvoidActive ? 'Idle Avoid Activity' : appName;
        const effectiveTitle = idleAvoidActive
            ? `Likely jiggler on ${appName}${pageTitle ? ` - ${String(pageTitle).substring(0, 120)}` : ''}`
            : pageTitle;
        const category = idleAvoidActive ? 'uncategorized' : realCategory;

        if (currentSpan && currentSpan.app === effectiveApp && currentSpan.title === effectiveTitle) {
            currentSpan.endTime = now;
            return;
        }

        if (currentSpan) {
            currentSpan.endTime = now;
            currentSpan.durationSeconds = Math.round((currentSpan.endTime - currentSpan.startTime) / 1000);
            if (currentSpan.durationSeconds > 0) {
                spans.push({ ...currentSpan });
            }
        }

        currentSpan = {
            app: effectiveApp,
            title: effectiveTitle,
            category,
            startTime: now,
            endTime: now,
            durationSeconds: 0,
            ...(browser && !idleAvoidActive ? { url: pageTitle } : {}),
            ...(idleAvoidActive ? { source: 'idle_avoid', detectionReason: idleAvoidState.reason } : {})
        };

        try {
            const rtdb = ctx.getRtdb();
            if (rtdb) {
                const ref = rtdb.ref(`appTracking/${ctx.getUid()}`);
                await ref.set({ app: effectiveApp, title: effectiveTitle, category, since: now });
            }
        } catch (_) { }

        try {
            const redFlags = settings.redFlagCategories || [];
            if (!idleAvoidActive && redFlags.includes(category)) {
                const wrote = await writeAppAlert({
                    app: appName,
                    title: (pageTitle || '').substring(0, 200),
                    category,
                    alertType: 'red_flag',
                });
                if (wrote) {
                    ctx.log(`[app-tracker] red flag alert fired: ${appName} (${category})`);
                }
            }
        } catch (e) {
            ctx.log('[app-tracker] red flag alert write failed:', e?.message || e);
        }

        try {
            if (idleAvoidActive && !idleAvoidState.alertSent) {
                const activeMs = now - (idleAvoidState.startedAt || now);
                if (activeMs >= idleAvoidConfig.durationMs) {
                    idleAvoidState.alertSent = true;
                    const wrote = await writeAppAlert({
                        app: 'Idle Avoid Activity',
                        title: `Likely jiggler detected on ${appName}`.substring(0, 200),
                        category: 'uncategorized',
                        alertType: 'idle_avoid',
                        durationSeconds: Math.round(activeMs / 1000),
                        detectionReason: idleAvoidState.reason || 'repeating-idle-reset-pattern',
                    });
                    if (wrote) {
                        ctx.log('[app-tracker] idle-avoid alert fired');
                    }
                }
            }
        } catch (e) {
            ctx.log('[app-tracker] idle-avoid alert write failed:', e?.message || e);
        }

        try {
            const mw = ctx.getMainWindow();
            mw?.webContents?.send?.('app-tracking-update', { app: effectiveApp, title: effectiveTitle, category });
        } catch (_) { }

    } catch (_) { }
}
// --- Backup ---
function saveBackup() {
    try {
        const data = {
            uid: ctx.getUid(),
            date: getTrackingDateKey(),
            spans,
            currentSpan,
            savedAt: Date.now()
        };
        fs.writeFileSync(APP_TRACKER_BACKUP_PATH, JSON.stringify(data), 'utf8');
    } catch (e) {
        ctx.log('[app-tracker] backup write failed:', e.message);
    }
}

function loadBackup() {
    try {
        if (!fs.existsSync(APP_TRACKER_BACKUP_PATH)) return null;
        const raw = fs.readFileSync(APP_TRACKER_BACKUP_PATH, 'utf8');
        const data = JSON.parse(raw);
        const today = getTrackingDateKey();
        return (data && data.uid === ctx.getUid() && data.date === today) ? data : null;
    } catch (_) { return null; }
}

function clearBackup() {
    try {
        if (fs.existsSync(APP_TRACKER_BACKUP_PATH)) {
            // First, overwrite with empty state in case unlink fails due to file locks (common on Windows)
            fs.writeFileSync(APP_TRACKER_BACKUP_PATH, JSON.stringify({ uid: ctx.getUid(), date: getTrackingDateKey(), spans: [], currentSpan: null, savedAt: Date.now() }), 'utf8');
            // Then attempt to delete
            fs.unlinkSync(APP_TRACKER_BACKUP_PATH);
        }
    } catch (_) { }
}

// --- Lifecycle ---
function start() {
    if (!activeWin) { ctx.log('[app-tracker] active-win not available, tracking disabled'); return; }
    const settings = ctx.getAdminSettings();
    if (settings?.enableAppTracking !== true) { ctx.log('[app-tracker] tracking disabled by admin'); return; }

    const intervalSec = Math.max(5, Math.min(60, Number(settings?.appTrackingIntervalSeconds) || 10));
    ctx.log(`[app-tracker] starting (interval: ${intervalSec}s)`);

    // Prevent overlapping intervals
    stop();

    // Crash recovery (once per tracker session, with de-dup)
    if (!backupRecovered) {
        const backup = loadBackup();
        if (backup && backup.spans && backup.spans.length > 0) {
            ctx.log(`[app-tracker] recovered ${backup.spans.length} spans from backup`);
            const existingSpans = spans || [];
            const mergedRaw = [...backup.spans, ...existingSpans];
            const seen = new Set();
            spans = [];
            for (const item of mergedRaw) {
                const fp = getEntryFingerprint(item);
                if (seen.has(fp)) continue;
                seen.add(fp);
                spans.push(item);
            }
        }
        backupRecovered = true;
    }

    paused = false;
    pollInterval = setInterval(tick, intervalSec * 1000);
    tick(); // immediate first check

    // Local backup every 5 minutes
    backupInterval = setInterval(saveBackup, 5 * 60 * 1000);
}

function stop() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
    ctx.log('[app-tracker] stopped');
}

function pause() { paused = true; }
function resume() { paused = false; }

function getEntryFingerprint(entry) {
    return [
        entry?.app || '',
        entry?.title || '',
        entry?.category || '',
        Number(entry?.startTime) || 0,
        Number(entry?.endTime) || 0,
        Number(entry?.durationSeconds) || 0,
        entry?.url || '',
        entry?.source || '',
        entry?.detectionReason || ''
    ].join('|');
}

function buildTopAppsFromEntries(entries) {
    const appTotals = {};
    for (const e of entries || []) {
        const app = e?.app;
        if (!app) continue;
        const dur = Number(e?.durationSeconds) || 0;
        if (!appTotals[app]) {
            appTotals[app] = {
                app,
                seconds: 0,
                categorySeconds: {}
            };
        }
        appTotals[app].seconds += dur;
        const cat = e?.category || 'uncategorized';
        appTotals[app].categorySeconds[cat] = (appTotals[app].categorySeconds[cat] || 0) + dur;
    }

    const ranked = Object.values(appTotals).map((item) => {
        const categoryEntries = Object.entries(item.categorySeconds || {});
        categoryEntries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
        const dominantCategory = (categoryEntries[0]?.[0]) || 'uncategorized';
        return {
            app: item.app,
            category: dominantCategory,
            seconds: item.seconds || 0
        };
    });

    return ranked.sort((a, b) => b.seconds - a.seconds).slice(0, 20);
}

// --- Firestore Flush (called at clock-out) ---
async function flush() {
    if (flushInFlight) {
        ctx.log('[app-tracker] flush already in progress, joining existing flush');
        return flushInFlight;
    }

    flushInFlight = (async () => {
    // Close current span
    if (currentSpan) {
        currentSpan.endTime = Date.now();
        currentSpan.durationSeconds = Math.round((currentSpan.endTime - currentSpan.startTime) / 1000);
        if (currentSpan.durationSeconds > 0) {
            spans.push({ ...currentSpan });
        }
        currentSpan = null;
    }

    ctx.log(`[app-tracker] flush triggered. total spans in memory: ${spans.length}`);

    if (spans.length === 0) {
        ctx.log('[app-tracker] no spans to flush');
        clearBackup();
        return;
    }

    const uid = ctx.getUid();
    if (!uid) { ctx.log('[app-tracker] no uid, cannot flush'); return; }

    const date = getTrackingDateKey();
    const spansToFlush = spans.map((s) => ({ ...s }));
    // Clear in-memory queue now so a second flush invocation cannot re-use the same spans.
    spans = [];

    // Build summary
    const byCategory = {};
    let totalTrackedSeconds = 0;

    for (const span of spansToFlush) {
        const dur = span.durationSeconds || 0;
        totalTrackedSeconds += dur;
        byCategory[span.category] = (byCategory[span.category] || 0) + dur;
    }

    const entries = spansToFlush.map(s => ({
        app: s.app,
        title: (s.title || '').substring(0, 200),
        category: s.category,
        startTime: s.startTime,
        endTime: s.endTime,
        durationSeconds: s.durationSeconds,
        ...(s.url ? { url: s.url.substring(0, 200) } : {}),
        ...(s.source ? { source: s.source } : {}),
        ...(s.detectionReason ? { detectionReason: s.detectionReason } : {})
    }));
    const topApps = buildTopAppsFromEntries(entries);

    const summary = { userId: uid, date, totalTrackedSeconds, byCategory, topApps, entries };

    try {
        const authed = await ctx.ensureAuth();
        if (!authed) {
            ctx.log('[app-tracker] auth missing on flush, saving backup');
            saveBackup();
            return;
        }

        const firestoreDb = ctx.getDb();
        const docId = `${uid}_${date}`;
        const docRef = firestoreDb.collection('appActivity').doc(docId);

        // Read existing document for the day so we can accumulate across multiple sessions
        let mergedEntries = [...entries];
        try {
            const existing = await docRef.get();
            if (existing.exists) {
                const prevData = existing.data();
                const prevEntries = Array.isArray(prevData?.entries) ? prevData.entries : [];
                // Append previous session entries before today's new ones, then remove duplicates.
                const mergedRaw = [...prevEntries, ...entries];
                const seen = new Set();
                mergedEntries = [];
                for (const item of mergedRaw) {
                    const fp = getEntryFingerprint(item);
                    if (seen.has(fp)) continue;
                    seen.add(fp);
                    mergedEntries.push(item);
                }
            }
        } catch (_) {
            // If read fails, just use current session entries (safe fallback)
        }

        // Recompute totals from the full merged entry list
        const mergedByCategory = {};
        let mergedTotal = 0;
        for (const e of mergedEntries) {
            const dur = e.durationSeconds || 0;
            mergedTotal += dur;
            mergedByCategory[e.category] = (mergedByCategory[e.category] || 0) + dur;
        }
        const mergedTopApps = buildTopAppsFromEntries(mergedEntries);

        const finalDoc = {
            userId: uid,
            date,
            totalTrackedSeconds: mergedTotal,
            byCategory: mergedByCategory,
            topApps: mergedTopApps,
            entries: mergedEntries,
        };

        await docRef.set(finalDoc);
        ctx.log(`[app-tracker] flushed ${entries.length} new spans (${mergedEntries.length} total for day) to Firestore (${docId})`);

        // Clear RTDB node
        try {
            const rtdb = ctx.getRtdb();
            if (rtdb) await rtdb.ref(`appTracking/${uid}`).remove();
        } catch (_) { }

        clearBackup();
    } catch (err) {
        ctx.log('[app-tracker] flush failed, saving backup:', err?.message || err);
        spans = [...spansToFlush, ...spans];
        saveBackup();
    }
    })();

    try {
        return await flushInFlight;
    } finally {
        flushInFlight = null;
    }
}

function reset() {
    stop();
    clearBackup(); // Ensure backup is cleared on reset
    spans = [];
    currentSpan = null;
    paused = false;
    backupRecovered = false;
    lastWindowFingerprint = '';
    resetIdleAvoidState();
}

// --- IPC ---
function registerIpc() {
    ipcMain.handle('get-app-tracking-status', () => {
        const enabled = ctx.getAdminSettings()?.enableAppTracking === true && activeWin !== null;
        return {
            enabled,
            currentApp: currentSpan?.app || null,
            currentCategory: currentSpan?.category || null
        };
    });
}

// --- Init (called from main.js) ---
function init(context) {
    ctx = { ...ctx, ...context };
    registerIpc();
}

module.exports = { init, start, stop, pause, resume, flush, reset };
