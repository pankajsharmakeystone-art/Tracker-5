"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enforceSingleActiveDesktopSession = exports.autoClockOutAtShiftEnd = exports.dailyMidnightCleanup = exports.dropboxOauthCallback = exports.dropboxOauthStart = exports.createDropboxOauthSession = exports.issueDesktopToken = void 0;
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-functions/v2/firestore");
const node_fetch_1 = require("node-fetch");
const crypto = require("crypto");
const luxon_1 = require("luxon");
admin.initializeApp();
const db = admin.firestore();
const DEFAULT_TIMEZONE = "Asia/Kolkata";
const DEFAULT_AUTO_CLOCK_GRACE_MINUTES = 10;
let cachedTimezone = DEFAULT_TIMEZONE;
let lastTimezoneFetch = 0;
const getOrganizationTimezone = async () => {
    const now = Date.now();
    const cacheIsFresh = now - lastTimezoneFetch < 5 * 60 * 1000;
    if (cacheIsFresh)
        return cachedTimezone;
    try {
        const snap = await db.collection("adminSettings").doc("global").get();
        if (snap.exists) {
            const data = snap.data();
            cachedTimezone = (data === null || data === void 0 ? void 0 : data.organizationTimezone) || DEFAULT_TIMEZONE;
        }
        else {
            cachedTimezone = DEFAULT_TIMEZONE;
        }
    }
    catch (error) {
        console.error("Failed to load organization timezone", error);
        cachedTimezone = DEFAULT_TIMEZONE;
    }
    lastTimezoneFetch = now;
    return cachedTimezone;
};
const buildShiftBoundary = (logStartDate, timeStr, useOvernight, timezone) => {
    if (!timeStr)
        return null;
    const [hour, minute] = timeStr.split(":").map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute))
        return null;
    const base = luxon_1.DateTime.fromJSDate(logStartDate, { zone: timezone || DEFAULT_TIMEZONE });
    let referenceDay = useOvernight ? base.plus({ days: 1 }) : base;
    let target = referenceDay.set({ hour, minute, second: 0, millisecond: 0 });
    // Safety: if the computed shift end is not after the start (common when overnight flag is missing)
    // bump it to the next day to avoid back-dated clock-outs like 00:00 durations.
    if (target <= base) {
        target = target.plus({ days: 1 });
    }
    return target.toUTC().toJSDate();
};
const inferProjectId = () => {
    if (process.env.GCLOUD_PROJECT)
        return process.env.GCLOUD_PROJECT;
    if (process.env.GCP_PROJECT)
        return process.env.GCP_PROJECT;
    if (process.env.FIREBASE_CONFIG) {
        try {
            const parsed = JSON.parse(process.env.FIREBASE_CONFIG);
            if (parsed === null || parsed === void 0 ? void 0 : parsed.projectId)
                return parsed.projectId;
        }
        catch (e) {
            console.warn("Failed to parse FIREBASE_CONFIG for projectId", e);
        }
    }
    return admin.app().options.projectId || "tracker-5";
};
const PROJECT_ID = inferProjectId();
const FUNCTIONS_REGION = "us-central1";
const FUNCTION_BASE_URL = `https://${FUNCTIONS_REGION}-${PROJECT_ID}.cloudfunctions.net`;
const DROPBOX_CALLBACK_URL = `${FUNCTION_BASE_URL}/dropboxOauthCallback`;
const allowCors = (res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
};
const parseBearerToken = (headerValue) => {
    if (!headerValue)
        return null;
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!raw)
        return null;
    const [scheme, token] = raw.split(' ');
    if (!scheme || !token)
        return null;
    return scheme.toLowerCase() === 'bearer' ? token.trim() : null;
};
const ensureAdminUser = async (uid) => {
    const userSnap = await db.collection('users').doc(uid).get();
    const data = userSnap.data();
    if (!userSnap.exists || ((data === null || data === void 0 ? void 0 : data.role) !== 'admin' && (data === null || data === void 0 ? void 0 : data.role) !== 'super_admin')) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required.');
    }
};
const DROPBOX_SESSIONS_COLLECTION = "dropboxSessions";
const isRecent = (value) => {
    if (!value || !value.toDate)
        return false;
    const created = value.toDate().getTime();
    return Date.now() - created < 10 * 60 * 1000; // 10 minutes
};
const sendHtml = (res, content, status = 200) => {
    res.status(status).set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><html><head><title>Dropbox Authorization</title><style>body{font-family:Arial,sans-serif;background:#f7f7f7;margin:0;padding:40px;color:#111;} .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 10px 35px rgba(0,0,0,0.08);} h1{font-size:22px;margin-bottom:18px;} p{line-height:1.5;margin:12px 0;} .success{color:#0f9d58;} .error{color:#d93025;} a{color:#1a73e8;} button{border:none;background:#1a73e8;color:#fff;padding:12px 18px;border-radius:8px;font-size:15px;cursor:pointer;margin-top:20px;}</style></head><body><div class="card">${content}</div></body></html>`);
};
const shouldTreatAsOvernight = (logData) => {
    if ((logData === null || logData === void 0 ? void 0 : logData.isOvernightShift) === true)
        return true;
    const start = typeof (logData === null || logData === void 0 ? void 0 : logData.scheduledStart) === "string" ? logData.scheduledStart : "";
    const end = typeof (logData === null || logData === void 0 ? void 0 : logData.scheduledEnd) === "string" ? logData.scheduledEnd : "";
    if (!start || !end)
        return false;
    return end < start;
};
const getTimestampMillis = (value) => {
    if (!value)
        return null;
    if (value instanceof admin.firestore.Timestamp)
        return value.toMillis();
    const maybe = value;
    if (typeof (maybe === null || maybe === void 0 ? void 0 : maybe.toMillis) === "function")
        return maybe.toMillis();
    if (typeof (maybe === null || maybe === void 0 ? void 0 : maybe.toDate) === "function")
        return maybe.toDate().getTime();
    if (value instanceof Date)
        return value.getTime();
    if (typeof value === "number")
        return value;
    return null;
};
const cloneEntryArray = (raw) => (Array.isArray(raw) ? raw.map((entry) => (Object.assign({}, entry))) : []);
const closeLatestActivityEntry = (raw, endTime) => {
    const activities = cloneEntryArray(raw);
    if (!activities.length)
        return null;
    const lastIndex = activities.length - 1;
    const last = Object.assign({}, activities[lastIndex]);
    if (!last.endTime) {
        last.endTime = endTime;
        activities[lastIndex] = last;
        return activities;
    }
    return null;
};
const closeOpenBreakEntry = (raw, endTime) => {
    const breaks = cloneEntryArray(raw);
    if (!breaks.length)
        return null;
    const lastIndex = breaks.length - 1;
    const last = Object.assign({}, breaks[lastIndex]);
    if (!last.endTime) {
        last.endTime = endTime;
        breaks[lastIndex] = last;
        return breaks;
    }
    return null;
};
const deriveDateKey = (logStartDate, timezone) => {
    try {
        return luxon_1.DateTime.fromJSDate(logStartDate)
            .setZone(timezone || DEFAULT_TIMEZONE, { keepLocalTime: false })
            .toISODate();
    }
    catch (_a) {
        return null;
    }
};
exports.issueDesktopToken = functions
    .region(FUNCTIONS_REGION)
    .https.onCall(async (_data, context) => {
    if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }
    const uid = context.auth.uid;
    try {
        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) {
            throw new functions.https.HttpsError("permission-denied", "User profile not found.");
        }
        const user = userSnap.data() || {};
        if (user.desktopDisabled === true) {
            throw new functions.https.HttpsError("permission-denied", "Desktop access disabled for this user.");
        }
        const token = await admin.auth().createCustomToken(uid, { desktop: true });
        return { token };
    }
    catch (err) {
        console.error("issueDesktopToken error", err);
        if (err instanceof functions.https.HttpsError) {
            throw err;
        }
        throw new functions.https.HttpsError("internal", "Unable to issue desktop token.");
    }
});
exports.createDropboxOauthSession = functions.https.onRequest(async (req, res) => {
    allowCors(res);
    if (req.method === "OPTIONS") {
        res.status(204).send("OK");
        return;
    }
    if (req.method !== "POST") {
        res.status(405).json({ error: "method-not-allowed" });
        return;
    }
    try {
        const token = parseBearerToken(req.headers.authorization);
        if (!token) {
            res.status(401).json({ error: "missing-authorization" });
            return;
        }
        const decoded = await admin.auth().verifyIdToken(token);
        await ensureAdminUser(decoded.uid);
        const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        const { appKey, appSecret } = payload || {};
        if (!appKey || !appSecret) {
            res.status(400).json({ error: "missing-app-credentials" });
            return;
        }
        const sessionRef = db.collection(DROPBOX_SESSIONS_COLLECTION).doc();
        const stateSecret = crypto.randomBytes(24).toString("hex");
        await sessionRef.set({
            uid: decoded.uid,
            appKey,
            appSecret,
            stateSecret,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "pending"
        });
        const startUrl = `${FUNCTION_BASE_URL}/dropboxOauthStart?session=${sessionRef.id}`;
        res.status(200).json({ startUrl });
    }
    catch (err) {
        console.error("createDropboxOauthSession error", err);
        if (err instanceof functions.https.HttpsError) {
            res.status(403).json({ error: err.message });
            return;
        }
        res.status(500).json({ error: "internal-error" });
    }
});
exports.dropboxOauthStart = functions.https.onRequest(async (req, res) => {
    const sessionId = req.query.session || "";
    if (!sessionId) {
        res.status(400).send("Missing session parameter");
        return;
    }
    const sessionSnap = await db.collection(DROPBOX_SESSIONS_COLLECTION).doc(sessionId).get();
    if (!sessionSnap.exists) {
        res.status(404).send("Session not found");
        return;
    }
    const session = sessionSnap.data();
    if (!session.appKey || !session.stateSecret || !isRecent(session.createdAt)) {
        res.status(400).send("Session expired. Restart authorization from the dashboard.");
        return;
    }
    const dropboxAuthorizeUrl = new URL("https://www.dropbox.com/oauth2/authorize");
    dropboxAuthorizeUrl.searchParams.set("response_type", "code");
    dropboxAuthorizeUrl.searchParams.set("client_id", session.appKey);
    dropboxAuthorizeUrl.searchParams.set("token_access_type", "offline");
    dropboxAuthorizeUrl.searchParams.set("redirect_uri", DROPBOX_CALLBACK_URL);
    dropboxAuthorizeUrl.searchParams.set("state", `${sessionId}|${session.stateSecret}`);
    res.redirect(dropboxAuthorizeUrl.toString());
});
exports.dropboxOauthCallback = functions.https.onRequest(async (req, res) => {
    const { state, code, error, error_description: errorDescription } = req.query;
    if (error) {
        sendHtml(res, `<h1 class="error">Dropbox authorization failed</h1><p>${error}: ${errorDescription || ""}</p><p>Close this window and retry from the dashboard.</p>`, 400);
        return;
    }
    if (!state || !code) {
        sendHtml(res, '<h1 class="error">Missing data</h1><p>The Dropbox response was incomplete. Please restart the flow.</p>', 400);
        return;
    }
    const [sessionId, secret] = state.split("|");
    if (!sessionId || !secret) {
        sendHtml(res, '<h1 class="error">Invalid state</h1><p>Unable to verify the authorization session.</p>', 400);
        return;
    }
    const sessionRef = db.collection(DROPBOX_SESSIONS_COLLECTION).doc(sessionId);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
        sendHtml(res, '<h1 class="error">Session expired</h1><p>Return to the app and start again.</p>', 400);
        return;
    }
    const session = sessionSnap.data();
    if (session.stateSecret !== secret) {
        sendHtml(res, '<h1 class="error">State mismatch</h1><p>Please restart the Dropbox authorization process.</p>', 400);
        return;
    }
    if (!isRecent(session.createdAt)) {
        sendHtml(res, '<h1 class="error">Session expired</h1><p>The authorization took too long. Restart from the app.</p>', 400);
        return;
    }
    try {
        const body = new URLSearchParams({
            code,
            grant_type: "authorization_code",
            client_id: session.appKey,
            client_secret: session.appSecret,
            redirect_uri: DROPBOX_CALLBACK_URL
        });
        const tokenResponse = await (0, node_fetch_1.default)("https://api.dropboxapi.com/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });
        const json = await tokenResponse.json();
        if (!tokenResponse.ok || !json.refresh_token) {
            console.error("Dropbox token exchange failed", json);
            await sessionRef.set({ status: "error" }, { merge: true });
            sendHtml(res, `<h1 class="error">Dropbox rejected the code</h1><p>${json.error_description || "Please try again."}</p>`, 400);
            return;
        }
        const expiresInSeconds = json.expires_in || 4 * 60 * 60;
        const expiryIso = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
        await db.collection("adminSettings").doc("global").set({
            dropboxRefreshToken: json.refresh_token,
            dropboxAccessToken: json.access_token,
            dropboxTokenExpiry: expiryIso,
            dropboxAppKey: session.appKey,
            dropboxAppSecret: session.appSecret
        }, { merge: true });
        await sessionRef.set({ status: "complete", completedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        sendHtml(res, '<h1 class="success">Dropbox connected!</h1><p>You can close this window. The app will start using the new refresh token automatically.</p><button onclick="window.close()">Close Window</button>');
    }
    catch (err) {
        console.error("dropboxOauthCallback error", err);
        await sessionRef.set({ status: "error" }, { merge: true });
        sendHtml(res, '<h1 class="error">Unexpected error</h1><p>We could not save the refresh token. Please try again.</p>', 500);
    }
});
/**
 * Daily Midnight Cleanup (Rule N1 Compliant)
 * Runs at 00:05.
 *
 * Goal: Close non-overnight sessions from previous days that were forgotten.
 * CRITICAL: Do NOT close sessions marked as `isOvernightShift: true`.
 */
exports.dailyMidnightCleanup = (0, scheduler_1.onSchedule)("5 0 * * *", async (event) => {
    console.log("Starting daily midnight cleanup...");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = admin.firestore.Timestamp.fromDate(today);
    // Find stale active logs started before today
    const snapshot = await db.collection("worklogs")
        .where("status", "in", ["working", "on_break", "break"])
        .where("date", "<", todayTs)
        .get();
    if (snapshot.empty)
        return;
    const batch = db.batch();
    let count = 0;
    snapshot.docs.forEach((doc) => {
        const data = doc.data();
        // Rule N1 Exception: Overnight shifts are allowed to cross midnight.
        // They will be closed by `autoClockOutAtShiftEnd` or manual action.
        if (shouldTreatAsOvernight(data)) {
            console.log(`Skipping overnight shift: ${doc.id}`);
            return;
        }
        console.log(`Force closing non-overnight stale log ${doc.id}`);
        // Close effectively at 23:59:59 of the start date
        const logDate = data.date.toDate();
        const endOfDay = new Date(logDate);
        endOfDay.setHours(23, 59, 59, 999);
        batch.update(db.collection("worklogs").doc(doc.id), {
            status: "clocked_out",
            clockOutTime: admin.firestore.Timestamp.fromDate(endOfDay),
            lastEventTimestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        batch.update(db.collection("agentStatus").doc(data.userId), {
            status: "offline",
            manualBreak: false,
            breakStartedAt: admin.firestore.FieldValue.delete()
        });
        batch.update(db.collection("users").doc(data.userId), {
            isLoggedIn: false,
            activeSession: admin.firestore.FieldValue.delete()
        });
        count++;
    });
    if (count > 0) {
        await batch.commit();
        console.log(`Closed ${count} stale non-overnight sessions.`);
    }
});
/**
 * Auto Clock-Out at Shift End
 * Enforces schedule limits.
 */
exports.autoClockOutAtShiftEnd = (0, scheduler_1.onSchedule)("every 5 minutes", async () => {
    var _a;
    const now = new Date();
    const organizationTimezone = await getOrganizationTimezone();
    const adminSettingsSnap = await db.collection("adminSettings").doc("global").get();
    const adminSettings = adminSettingsSnap.exists ? adminSettingsSnap.data() : {};
    const autoClockOutEnabled = (adminSettings === null || adminSettings === void 0 ? void 0 : adminSettings.autoClockOutEnabled) === true;
    if (!autoClockOutEnabled) {
        console.log("[autoClockOut] Skipping: autoClockOutEnabled is false");
        return;
    }
    const autoClockGraceMinutesRaw = typeof adminSettings.autoClockGraceMinutes === "number"
        ? adminSettings.autoClockGraceMinutes
        : DEFAULT_AUTO_CLOCK_GRACE_MINUTES;
    const autoClockGraceMinutes = autoClockGraceMinutesRaw < 0 ? 0 : autoClockGraceMinutesRaw;
    const autoClockGraceMs = autoClockGraceMinutes * 60 * 1000;
    const snapshot = await db.collection("worklogs")
        .where("status", "in", ["working", "on_break", "break"])
        .get();
    if (snapshot.empty)
        return;
    const batch = db.batch();
    let count = 0;
    const slotCache = new Map();
    const getAutoClockSlot = async (userId, dateKey) => {
        if (!userId || !dateKey)
            return null;
        if (!slotCache.has(userId)) {
            const snap = await db.collection("autoClockConfigs").doc(userId).get();
            slotCache.set(userId, snap.exists ? snap.data() : {});
        }
        const config = slotCache.get(userId) || {};
        return (config === null || config === void 0 ? void 0 : config[dateKey]) || null;
    };
    for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        if (!(data === null || data === void 0 ? void 0 : data.date) || !(data === null || data === void 0 ? void 0 : data.userId))
            continue;
        const logStartDate = data.date.toDate();
        const dateKey = deriveDateKey(logStartDate, organizationTimezone);
        const slot = await getAutoClockSlot(data.userId, dateKey);
        const scheduledEnd = (slot === null || slot === void 0 ? void 0 : slot.shiftEndTime) || data.scheduledEnd;
        if (!scheduledEnd)
            continue;
        // Always use the organization timezone for schedule calculations
        const timezoneForLog = organizationTimezone;
        const useOvernight = (_a = slot === null || slot === void 0 ? void 0 : slot.isOvernightShift) !== null && _a !== void 0 ? _a : shouldTreatAsOvernight(data);
        const shiftEndDate = buildShiftBoundary(logStartDate, scheduledEnd, useOvernight, timezoneForLog);
        if (!shiftEndDate)
            continue;
        if (now <= shiftEndDate)
            continue;
        const shiftEndTs = admin.firestore.Timestamp.fromDate(shiftEndDate);
        const shiftEndMillis = shiftEndDate.getTime();
        const lastEventMillis = getTimestampMillis(data.lastEventTimestamp);
        const msSinceLastEvent = lastEventMillis != null ? (now.getTime() - lastEventMillis) : null;
        const activitiesArray = Array.isArray(data.activities) ? data.activities : [];
        const lastActivity = activitiesArray.length ? activitiesArray[activitiesArray.length - 1] : null;
        const hasOpenActivity = Boolean(lastActivity && !lastActivity.endTime);
        if (hasOpenActivity && msSinceLastEvent != null && msSinceLastEvent < autoClockGraceMs) {
            console.log("[autoClockOut] Skipping due to recent activity", {
                logId: docSnap.id,
                userId: data.userId,
                shiftEnd: shiftEndDate.toISOString(),
                msSinceLastEvent,
                graceMs: autoClockGraceMs
            });
            continue;
        }
        const normalizedStatus = (data.status || "working").toString().toLowerCase();
        let workDelta = 0;
        let breakDelta = 0;
        if (lastEventMillis != null && shiftEndMillis > lastEventMillis) {
            const elapsedSeconds = (shiftEndMillis - lastEventMillis) / 1000;
            if (["on_break", "break"].includes(normalizedStatus)) {
                breakDelta = elapsedSeconds;
            }
            else {
                workDelta = elapsedSeconds;
            }
        }
        const workLogRef = db.collection("worklogs").doc(docSnap.id);
        const updates = {
            status: "clocked_out",
            clockOutTime: shiftEndTs,
            lastEventTimestamp: shiftEndTs,
        };
        if (workDelta > 0) {
            updates.totalWorkSeconds = admin.firestore.FieldValue.increment(workDelta);
        }
        if (breakDelta > 0) {
            updates.totalBreakSeconds = admin.firestore.FieldValue.increment(breakDelta);
        }
        const updatedActivities = closeLatestActivityEntry(data.activities, shiftEndTs);
        if (updatedActivities) {
            updates.activities = updatedActivities;
        }
        const updatedBreaks = closeOpenBreakEntry(data.breaks, shiftEndTs);
        if (updatedBreaks) {
            updates.breaks = updatedBreaks;
        }
        console.log("[autoClockOut] Closing session", {
            logId: docSnap.id,
            userId: data.userId,
            shiftEnd: shiftEndDate.toISOString(),
            autoClockGraceMinutes,
            msSinceLastEvent
        });
        batch.update(workLogRef, updates);
        batch.set(db.collection("agentStatus").doc(data.userId), {
            status: "offline",
            manualBreak: false,
            breakStartedAt: admin.firestore.FieldValue.delete(),
            lastUpdate: shiftEndTs
        }, { merge: true });
        batch.set(db.collection("users").doc(data.userId), {
            isLoggedIn: false,
            activeSession: admin.firestore.FieldValue.delete(),
            lastClockOut: shiftEndTs,
            sessionClearedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        count++;
    }
    if (count > 0) {
        await batch.commit();
        console.log(`Auto clocked out ${count} session(s) at scheduled shift end.`);
    }
});
/**
 * Enforce single active desktop session.
 *
 * When the desktop writes users/{uid}.activeDesktopSessionId on login, this trigger:
 * - Force-closes any currently active worklog at "now" (best-effort, with deltas)
 * - Creates a new worklog starting at the new desktop login time
 * - Sends a targeted desktopCommands.forceLogout to the previous desktop session id
 */
exports.enforceSingleActiveDesktopSession = (0, firestore_1.onDocumentWritten)({ document: "users/{uid}", region: FUNCTIONS_REGION }, async (event) => {
    var _a, _b, _c, _d, _e;
    const uid = event.params.uid;
    const before = (_b = (_a = event.data) === null || _a === void 0 ? void 0 : _a.before) === null || _b === void 0 ? void 0 : _b.data();
    const after = (_d = (_c = event.data) === null || _c === void 0 ? void 0 : _c.after) === null || _d === void 0 ? void 0 : _d.data();
    if (!after)
        return;
    const newSessionId = after.activeDesktopSessionId ? String(after.activeDesktopSessionId) : null;
    if (!newSessionId)
        return;
    let oldSessionId = (before === null || before === void 0 ? void 0 : before.activeDesktopSessionId) ? String(before.activeDesktopSessionId) : null;
    if (oldSessionId && oldSessionId === newSessionId)
        return;
    // Fallback: if older desktop builds didn't persist activeDesktopSessionId,
    // try reading the current RTDB presence sessionId so we can still target force-logout.
    if (!oldSessionId) {
        try {
            const snap = await admin.database().ref(`presence/${uid}`).once('value');
            const presence = (_e = snap === null || snap === void 0 ? void 0 : snap.val) === null || _e === void 0 ? void 0 : _e.call(snap);
            const presenceSessionId = (presence === null || presence === void 0 ? void 0 : presence.sessionId) ? String(presence.sessionId) : null;
            const presenceSource = (presence === null || presence === void 0 ? void 0 : presence.source) ? String(presence.source) : null;
            const presenceState = (presence === null || presence === void 0 ? void 0 : presence.state) ? String(presence.state) : null;
            if (presenceSessionId && presenceSource === 'desktop' && presenceState === 'online' && presenceSessionId !== newSessionId) {
                oldSessionId = presenceSessionId;
            }
        }
        catch (e) {
            console.warn('[enforceSingleActiveDesktopSession] RTDB presence fallback failed', e);
        }
    }
    const nowTs = admin.firestore.Timestamp.now();
    // Find and close any active worklog for this user.
    const activeSnap = await db
        .collection("worklogs")
        .where("userId", "==", uid)
        .where("status", "in", ["working", "on_break", "break"])
        .orderBy("clockInTime", "desc")
        .limit(1)
        .get();
    const batch = db.batch();
    if (!activeSnap.empty) {
        const docSnap = activeSnap.docs[0];
        const data = docSnap.data() || {};
        const lastEventMillis = getTimestampMillis(data.lastEventTimestamp);
        const nowMillis = nowTs.toMillis();
        let workDelta = 0;
        let breakDelta = 0;
        if (lastEventMillis != null && nowMillis > lastEventMillis) {
            const elapsedSeconds = (nowMillis - lastEventMillis) / 1000;
            const normalizedStatus = (data.status || "working").toString().toLowerCase();
            if (["on_break", "break"].includes(normalizedStatus)) {
                breakDelta = elapsedSeconds;
            }
            else {
                workDelta = elapsedSeconds;
            }
        }
        const updates = {
            status: "clocked_out",
            clockOutTime: nowTs,
            lastEventTimestamp: nowTs,
        };
        if (workDelta > 0)
            updates.totalWorkSeconds = admin.firestore.FieldValue.increment(workDelta);
        if (breakDelta > 0)
            updates.totalBreakSeconds = admin.firestore.FieldValue.increment(breakDelta);
        const updatedActivities = closeLatestActivityEntry(data.activities, nowTs);
        if (updatedActivities)
            updates.activities = updatedActivities;
        const updatedBreaks = closeOpenBreakEntry(data.breaks, nowTs);
        if (updatedBreaks)
            updates.breaks = updatedBreaks;
        batch.update(db.collection("worklogs").doc(docSnap.id), updates);
    }
    // Create a new worklog starting at the new desktop login time.
    const userDisplayName = (after.displayName || after.userDisplayName || after.name || "").toString();
    const teamId = (after.teamId || (Array.isArray(after.teamIds) ? after.teamIds[0] : null)) || null;
    const newLogRef = db.collection("worklogs").doc();
    batch.set(newLogRef, {
        userId: uid,
        userDisplayName,
        teamId,
        date: nowTs,
        clockInTime: nowTs,
        clockOutTime: null,
        status: "working",
        activities: [
            {
                type: "working",
                startTime: nowTs,
                endTime: null,
            },
        ],
        breaks: [],
        totalWorkSeconds: 0,
        totalBreakSeconds: 0,
        lastEventTimestamp: nowTs,
        startedBy: "desktop_session_switch",
        desktopSessionId: newSessionId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Ensure agentStatus shows working after the switch.
    batch.set(db.collection("agentStatus").doc(uid), {
        status: "working",
        manualBreak: false,
        breakStartedAt: admin.firestore.FieldValue.delete(),
        lastUpdate: nowTs,
    }, { merge: true });
    // Force-logout the previous desktop session only.
    if (oldSessionId) {
        batch.set(db.collection("desktopCommands").doc(uid), {
            forceLogout: true,
            timestamp: nowTs,
            targetDesktopSessionId: oldSessionId,
            reason: "desktop_session_switch",
        }, { merge: true });
    }
    await batch.commit();
});
//# sourceMappingURL=index.js.map