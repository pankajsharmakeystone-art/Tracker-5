import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import type { ServiceAccount } from 'firebase-admin';
import crypto from 'node:crypto';
import serviceAccountJson from '../tracker-5-firebase-adminsdk-fbsvc-719d14ae45.json';

const DEFAULT_REGION = process.env.FIREBASE_FUNCTIONS_REGION || 'us-central1';
const DEFAULT_PROJECT = process.env.FIREBASE_PROJECT_ID || 'tracker-5';
const FUNCTIONS_BASE_URL = (process.env.FIREBASE_FUNCTIONS_BASE_URL || `https://${DEFAULT_REGION}-${DEFAULT_PROJECT}.cloudfunctions.net`).replace(/\/$/, '');

const DROPBOX_SESSIONS_COLLECTION = 'dropboxOauthSessions';

type IncomingBody = Record<string, unknown> | string | undefined | null;

interface NormalizedRequestBody {
  appKey?: string;
  appSecret?: string;
  idToken?: string;
}

const serviceAccount: ServiceAccount = {
  projectId: serviceAccountJson.project_id,
  clientEmail: serviceAccountJson.client_email,
  privateKey: (serviceAccountJson.private_key || '').replace(/\\n/g, '\n')
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const parseBearerToken = (header?: string | string[]) => {
  if (!header) return null;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value.match(/^Bearer\s+(.*)$/i);
  return match ? match[1] : null;
};

const parseRequestBody = (incoming: IncomingBody): NormalizedRequestBody => {
  if (incoming == null) return {};
  if (typeof incoming === 'string') {
    try {
      return parseRequestBody(JSON.parse(incoming));
    } catch (err) {
      console.warn('Failed to parse Dropbox proxy body', err);
      return {};
    }
  }

  const body = incoming as Record<string, unknown>;
  return {
    appKey: typeof body.appKey === 'string' ? body.appKey : undefined,
    appSecret: typeof body.appSecret === 'string' ? body.appSecret : undefined,
    idToken: typeof body.idToken === 'string' ? body.idToken : undefined
  };
};

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const ensureAdminUser = async (uid: string) => {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    throw new HttpError(403, 'user-profile-not-found');
  }
  const data = userSnap.data();
  if (data?.role !== 'admin') {
    throw new HttpError(403, 'admin-only');
  }
  return data;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const body = parseRequestBody(req.body as IncomingBody);
  const token = parseBearerToken(req.headers.authorization) || body.idToken;

  if (!token) {
    res.status(401).json({ error: 'missing-authorization' });
    return;
  }

  if (!body.appKey || !body.appSecret) {
    res.status(400).json({ error: 'missing-app-credentials' });
    return;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (!decoded?.uid) {
      throw new HttpError(401, 'invalid-token');
    }

    await ensureAdminUser(decoded.uid);

    const sessionRef = db.collection(DROPBOX_SESSIONS_COLLECTION).doc();
    const stateSecret = crypto.randomBytes(24).toString('hex');

    await sessionRef.set({
      uid: decoded.uid,
      appKey: body.appKey,
      appSecret: body.appSecret,
      stateSecret,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending'
    });

    const startUrl = `${FUNCTIONS_BASE_URL}/dropboxOauthStart?session=${sessionRef.id}`;
    res.status(200).json({ startUrl });
  } catch (error: any) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code });
      return;
    }

    const code = typeof error?.code === 'string' ? error.code : undefined;
    if (code && code.startsWith('auth/')) {
      res.status(401).json({ error: code });
      return;
    }

    console.error('Dropbox session proxy failed', error);
    res.status(500).json({ error: 'dropbox-proxy-failed' });
  }
}
