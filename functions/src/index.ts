
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import fetch from "node-fetch";
import * as crypto from "crypto";
import type { Response } from "express";

admin.initializeApp();
const db = admin.firestore();

const inferProjectId = (): string => {
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  if (process.env.FIREBASE_CONFIG) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_CONFIG);
      if (parsed?.projectId) return parsed.projectId;
    } catch (e) {
      console.warn("Failed to parse FIREBASE_CONFIG for projectId", e);
    }
  }
  return admin.app().options.projectId || "tracker-5";
};

const PROJECT_ID = inferProjectId();
const FUNCTIONS_REGION = "us-central1";
const FUNCTION_BASE_URL = `https://${FUNCTIONS_REGION}-${PROJECT_ID}.cloudfunctions.net`;
const DROPBOX_CALLBACK_URL = `${FUNCTION_BASE_URL}/dropboxOauthCallback`;

const allowCors = (res: Response) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
};

const DROPBOX_SESSIONS_COLLECTION = "dropboxOauthSessions";

interface DropboxSessionDoc {
  uid: string;
  appKey: string;
  appSecret: string;
  stateSecret: string;
  createdAt: admin.firestore.Timestamp;
  status: "pending" | "complete" | "error";
  completedAt?: admin.firestore.Timestamp;
}

const isRecent = (timestamp: admin.firestore.Timestamp | undefined, maxMinutes = 15) => {
  if (!timestamp) return false;
  const created = timestamp.toDate().getTime();
  return Date.now() - created < maxMinutes * 60 * 1000;
};

const ensureAdminUser = async (uid: string) => {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("permission-denied", "User profile not found.");
  }
  const data = userSnap.data();
  if (data?.role !== "admin") {
    throw new functions.https.HttpsError("permission-denied", "Admin privileges required.");
  }
  return data;
};

const parseBearerToken = (header?: string | string[]) => {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value.match(/^Bearer (.*)$/i);
  return match ? match[1] : null;
};

const sendHtml = (res: Response, content: string, status = 200) => {
  res.status(status).set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html><html><head><title>Dropbox Authorization</title><style>body{font-family:Arial,sans-serif;background:#f7f7f7;margin:0;padding:40px;color:#111;} .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 10px 35px rgba(0,0,0,0.08);} h1{font-size:22px;margin-bottom:18px;} p{line-height:1.5;margin:12px 0;} .success{color:#0f9d58;} .error{color:#d93025;} a{color:#1a73e8;} button{border:none;background:#1a73e8;color:#fff;padding:12px 18px;border-radius:8px;font-size:15px;cursor:pointer;margin-top:20px;}</style></head><body><div class="card">${content}</div></body></html>`);
};

export const createDropboxOauthSession = functions.https.onRequest(async (req, res) => {
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
  } catch (err: any) {
    console.error("createDropboxOauthSession error", err);
    if (err instanceof functions.https.HttpsError) {
      res.status(403).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: "internal-error" });
  }
});

export const dropboxOauthStart = functions.https.onRequest(async (req, res) => {
  const sessionId = (req.query.session as string) || "";
  if (!sessionId) {
    res.status(400).send("Missing session parameter");
    return;
  }

  const sessionSnap = await db.collection(DROPBOX_SESSIONS_COLLECTION).doc(sessionId).get();
  if (!sessionSnap.exists) {
    res.status(404).send("Session not found");
    return;
  }

  const session = sessionSnap.data() as DropboxSessionDoc;
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

export const dropboxOauthCallback = functions.https.onRequest(async (req, res) => {
  const { state, code, error, error_description: errorDescription } = req.query as Record<string, string>;

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

  const session = sessionSnap.data() as DropboxSessionDoc;
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

    const tokenResponse = await fetch("https://api.dropboxapi.com/oauth2/token", {
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
  } catch (err) {
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
export const dailyMidnightCleanup = onSchedule("5 0 * * *", async (event) => {
    console.log("Starting daily midnight cleanup...");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = admin.firestore.Timestamp.fromDate(today);

    // Find stale active logs started before today
    const snapshot = await db.collection("worklogs")
      .where("status", "in", ["working", "on_break", "break"])
      .where("date", "<", todayTs)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    let count = 0;

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      
      // Rule N1 Exception: Overnight shifts are allowed to cross midnight.
      // They will be closed by `autoClockOutAtShiftEnd` or manual action.
      if (data.isOvernightShift === true) {
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
export const autoClockOutAtShiftEnd = onSchedule("every 5 minutes", async (event) => {
      const now = new Date();
      const snapshot = await db.collection("worklogs")
        .where("status", "in", ["working", "on_break", "break"])
        .get();
      
      const batch = db.batch();
      let count = 0;
      
      const parseTime = (dateObj: Date, timeStr: string) => {
          const [hh, mm] = timeStr.split(":").map(Number);
          const newDate = new Date(dateObj);
          newDate.setHours(hh, mm, 0, 0);
          return newDate;
      };

      snapshot.docs.forEach((doc) => {
          const data = doc.data();
          if (!data.scheduledEnd || !data.date) return;

          let shiftEndDate: Date;
          const logStartDate = data.date.toDate();

          // Correctly calculate end time based on shift type
          if (data.isOvernightShift) {
              const nextDay = new Date(logStartDate);
              nextDay.setDate(nextDay.getDate() + 1);
              shiftEndDate = parseTime(nextDay, data.scheduledEnd);
          } else {
              shiftEndDate = parseTime(logStartDate, data.scheduledEnd);
          }

          // Buffer: Allow 15 mins past shift end? Strict for now.
          if (now > shiftEndDate) {
              console.log(`Auto-clocking out ${doc.id}. End: ${shiftEndDate.toISOString()}`);
              
              batch.update(db.collection("worklogs").doc(doc.id), {
                  status: "clocked_out",
                  clockOutTime: admin.firestore.Timestamp.fromDate(shiftEndDate),
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
          }
      });

        if (count > 0) await batch.commit();
  });
