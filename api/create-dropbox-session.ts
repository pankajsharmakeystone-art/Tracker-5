import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_REGION = process.env.FIREBASE_FUNCTIONS_REGION || 'us-central1';
const DEFAULT_PROJECT = process.env.FIREBASE_PROJECT_ID || 'tracker-5';
const FUNCTIONS_BASE_URL = (process.env.FIREBASE_FUNCTIONS_BASE_URL || `https://${DEFAULT_REGION}-${DEFAULT_PROJECT}.cloudfunctions.net`).replace(/\/$/, '');
const FUNCTION_PATH = process.env.DROPBOX_SESSION_FUNCTION || 'createDropboxOauthSession';

const targetUrl = `${FUNCTIONS_BASE_URL}/${FUNCTION_PATH}`;

function asJsonString(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }
  if (body === undefined || body === null) {
    return '{}';
  }
  try {
    return JSON.stringify(body);
  } catch (err) {
    console.warn('Failed to stringify request body for Dropbox proxy', err);
    return '{}';
  }
}

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

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'missing-authorization' });
    return;
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json'
      },
      body: asJsonString(req.body)
    });

    const text = await response.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const errorPayload = payload && typeof payload === 'object' ? payload : { error: 'dropbox-function-error' };
      res.status(response.status).json(errorPayload);
      return;
    }

    res.status(200).json(payload);
  } catch (error) {
    console.error('Dropbox session proxy failed', error);
    res.status(502).json({ error: 'dropbox-proxy-failed' });
  }
}
