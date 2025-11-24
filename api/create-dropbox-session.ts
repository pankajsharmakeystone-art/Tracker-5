import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';
import admin from 'firebase-admin';
import { getFirebaseServices } from './_lib/firebaseAdmin';
import { DROPBOX_SESSIONS_COLLECTION, inferExternalBaseUrl } from './_lib/dropbox';

const allowCors = (res: VercelResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
    firebase = getFirebaseServices();
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

    const baseUrl = inferExternalBaseUrl(req);
    res.status(200).json({ startUrl: `${baseUrl}/api/dropbox-start?session=${sessionRef.id}` });
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
