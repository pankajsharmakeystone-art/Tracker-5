import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import { getFirebaseServices } from './_lib/firebaseAdmin';
import { DROPBOX_SESSIONS_COLLECTION, isSessionRecent, buildCallbackUrl } from './_lib/dropbox';

interface DropboxSessionDoc {
  uid: string;
  appKey: string;
  appSecret: string;
  stateSecret: string;
  createdAt: admin.firestore.Timestamp;
}

const sendHtml = (res: VercelResponse, content: string, status = 200) => {
  res.status(status)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .send(`<!doctype html><html><head><title>Dropbox Authorization</title><style>body{font-family:Arial,sans-serif;background:#f7f7f7;margin:0;padding:40px;color:#111;} .card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 10px 35px rgba(0,0,0,0.08);} h1{font-size:22px;margin-bottom:18px;} p{line-height:1.5;margin:12px 0;} .success{color:#0f9d58;} .error{color:#d93025;} button{border:none;background:#1a73e8;color:#fff;padding:12px 18px;border-radius:8px;font-size:15px;cursor:pointer;margin-top:20px;}</style></head><body><div class="card">${content}</div></body></html>`);
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { state, code, error, error_description: errorDescription } = req.query as Record<string, string>;

  if (error) {
    sendHtml(res, `<h1 class="error">Dropbox authorization failed</h1><p>${error}: ${errorDescription || ''}</p><p>Close this window and retry from the dashboard.</p>`, 400);
    return;
  }

  if (!state || !code) {
    sendHtml(res, '<h1 class="error">Missing data</h1><p>The Dropbox response was incomplete. Please restart the flow.</p>', 400);
    return;
  }

  const [sessionId, secret] = state.split('|');
  if (!sessionId || !secret) {
    sendHtml(res, '<h1 class="error">Invalid state</h1><p>Unable to verify the authorization session.</p>', 400);
    return;
  }

  try {
    const { firestore } = getFirebaseServices();
    const sessionRef = firestore.collection(DROPBOX_SESSIONS_COLLECTION).doc(sessionId);
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

    if (!isSessionRecent(session.createdAt)) {
      sendHtml(res, '<h1 class="error">Session expired</h1><p>The authorization took too long. Restart from the app.</p>', 400);
      return;
    }

    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: session.appKey,
      client_secret: session.appSecret,
      redirect_uri: buildCallbackUrl(req),
    });

    const tokenResponse = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const json = await tokenResponse.json();
    if (!tokenResponse.ok || !json.refresh_token) {
      console.error('Dropbox token exchange failed', json);
      await sessionRef.set({ status: 'error' }, { merge: true });
      sendHtml(res, `<h1 class="error">Dropbox rejected the code</h1><p>${json.error_description || 'Please try again.'}</p>`, 400);
      return;
    }

    const expiresInSeconds = json.expires_in || 4 * 60 * 60;
    const expiryIso = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    await firestore.collection('adminSettings').doc('global').set({
      dropboxRefreshToken: json.refresh_token,
      dropboxAccessToken: json.access_token,
      dropboxTokenExpiry: expiryIso,
      dropboxAppKey: session.appKey,
      dropboxAppSecret: session.appSecret,
    }, { merge: true });

    await sessionRef.set({ status: 'complete', completedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    sendHtml(res, '<h1 class="success">Dropbox connected!</h1><p>You can close this window. The app will start using the new refresh token automatically.</p><button onclick="window.close()">Close Window</button>');
  } catch (err) {
    console.error('dropbox-callback error', err);
    sendHtml(res, '<h1 class="error">Unexpected error</h1><p>We could not save the refresh token. Please try again.</p>', 500);
  }
}
