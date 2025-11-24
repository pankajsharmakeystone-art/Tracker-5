import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import crypto from 'node:crypto';

const DROPBOX_SESSIONS_COLLECTION = 'dropboxOauthSessions';
const DEFAULT_REGION = process.env.FIREBASE_FUNCTIONS_REGION || 'us-central1';

const APP_NAME = 'dropbox-session-api';
let firebaseApp: admin.app.App | null = null;
let firestore: admin.firestore.Firestore | null = null;
let auth: admin.auth.Auth | null = null;
type ServiceAccountJSON = admin.ServiceAccount & {
  project_id?: string;
  private_key?: string;
  client_email?: string;
};

let cachedServiceAccount: ServiceAccountJSON | null = null;

const allowCors = (res: VercelResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
};

const sanitizeServiceAccount = (raw: string): ServiceAccountJSON => {
  const parsed = JSON.parse(raw) as ServiceAccountJSON;
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    if (!parsed.privateKey) parsed.privateKey = parsed.private_key;
  }
  if (parsed.client_email && !parsed.clientEmail) {
    parsed.clientEmail = parsed.client_email;
  }
  if (parsed.project_id && !parsed.projectId) {
    parsed.projectId = parsed.project_id;
  }
  return parsed;
};

const tryLoadServiceAccount = () => {
  if (cachedServiceAccount) return cachedServiceAccount;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    cachedServiceAccount = sanitizeServiceAccount(raw);
    return cachedServiceAccount;
  } catch (error) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON', error);
    return null;
  }
};

const parseServiceAccount = () => {
  if (cachedServiceAccount) return cachedServiceAccount;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is required');
  }
  try {
    cachedServiceAccount = sanitizeServiceAccount(raw);
    return cachedServiceAccount;
  } catch (error) {
    throw new Error('Unable to parse FIREBASE_SERVICE_ACCOUNT_JSON');
  }
};

const inferProjectId = () => {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT;
  const serviceAccount = tryLoadServiceAccount();
  if (serviceAccount?.project_id) return serviceAccount.project_id;
  if (firebaseApp?.options.projectId) return firebaseApp.options.projectId;
  return 'tracker-5';
};

const getFunctionsBaseUrl = () => {
  const raw = process.env.FIREBASE_FUNCTIONS_BASE_URL;
  if (raw) return raw.replace(/\/$/, '');
  return `https://${DEFAULT_REGION}-${inferProjectId()}.cloudfunctions.net`;
};

const initializeFirebase = () => {
  if (firebaseApp && firestore && auth) {
    return { firestore, auth };
  }

  const serviceAccount = parseServiceAccount();

  const existingApp = admin.apps.find((appInstance) => appInstance.name === APP_NAME);
  firebaseApp = existingApp || admin.initializeApp({
    credential: admin.credential.cert({
      projectId: serviceAccount.projectId || serviceAccount.project_id,
      clientEmail: serviceAccount.clientEmail || serviceAccount.client_email,
      privateKey: serviceAccount.privateKey || serviceAccount.private_key,
    }),
  }, APP_NAME);

  firestore = admin.firestore(firebaseApp);
  auth = admin.auth(firebaseApp);
  return { firestore, auth };
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const parseBearerToken = (header?: string | string[]) => {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value.match(/^Bearer (.*)$/i);
  return match ? match[1] : null;
};

const ensureAdminUser = async (uid: string, db: admin.firestore.Firestore) => {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    throw new HttpError(403, 'User profile not found');
  }
  const data = userSnap.data();
  if (data?.role !== 'admin') {
    throw new HttpError(403, 'Admin privileges required');
  }
};

const dropboxStartUrlForSession = (sessionId: string) => {
  return `${getFunctionsBaseUrl()}/dropboxOauthStart?session=${sessionId}`;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  allowCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  let firebase;
  try {
    firebase = initializeFirebase();
  } catch (error) {
    res.status(500).json({ error: 'firebase-initialization-failed', details: (error as Error).message });
    return;
  }

  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'missing-authorization' });
    return;
  }

  try {
    const decoded = await firebase.auth.verifyIdToken(token);
    await ensureAdminUser(decoded.uid, firebase.firestore);

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { appKey, appSecret } = payload || {};
    if (!appKey || !appSecret) {
      throw new HttpError(400, 'Missing Dropbox app key/secret');
    }

    const sessionRef = firebase.firestore.collection(DROPBOX_SESSIONS_COLLECTION).doc();
    const stateSecret = crypto.randomBytes(24).toString('hex');

    await sessionRef.set({
      uid: decoded.uid,
      appKey,
      appSecret,
      stateSecret,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
    });

    res.status(200).json({ startUrl: dropboxStartUrlForSession(sessionRef.id) });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if ((error as Error).name === 'JsonWebTokenError') {
      res.status(401).json({ error: 'invalid-id-token' });
      return;
    }
    console.error('create-dropbox-session error', error);
    res.status(500).json({ error: 'internal-error' });
  }
}
