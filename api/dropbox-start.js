import { getFirebaseServices } from './_lib/firebaseAdmin.js';
import { DROPBOX_SESSIONS_COLLECTION, isSessionRecent, buildCallbackUrl } from './_lib/dropbox.js';

const DROPBOX_SCOPES = [
  'files.content.write',
  'files.metadata.write',
].join(' ');

const allowOnlyGet = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return false;
  }
  if (req.method !== 'GET') {
    res.status(405).send('Method Not Allowed');
    return false;
  }
  return true;
};

export default async function handler(req, res) {
  if (!allowOnlyGet(req, res)) return;

  const sessionId = (req.query.session || '')?.toString();
  if (!sessionId) {
    res.status(400).send('Missing session parameter');
    return;
  }

  try {
    const { firestore } = getFirebaseServices();
    const sessionSnap = await firestore.collection(DROPBOX_SESSIONS_COLLECTION).doc(sessionId).get();

    if (!sessionSnap.exists) {
      res.status(404).send('Session not found');
      return;
    }

    const session = sessionSnap.data();
    if (!session?.appKey || !session?.stateSecret || !isSessionRecent(session.createdAt)) {
      res.status(400).send('Session expired. Restart authorization from the dashboard.');
      return;
    }

    const dropboxAuthorizeUrl = new URL('https://www.dropbox.com/oauth2/authorize');
    dropboxAuthorizeUrl.searchParams.set('response_type', 'code');
    dropboxAuthorizeUrl.searchParams.set('client_id', session.appKey);
    dropboxAuthorizeUrl.searchParams.set('token_access_type', 'offline');
    dropboxAuthorizeUrl.searchParams.set('redirect_uri', buildCallbackUrl(req));
    dropboxAuthorizeUrl.searchParams.set('state', `${sessionId}|${session.stateSecret}`);
    dropboxAuthorizeUrl.searchParams.set('scope', DROPBOX_SCOPES);

    res.writeHead(302, { Location: dropboxAuthorizeUrl.toString() });
    res.end();
  } catch (error) {
    console.error('dropbox-start error', error);
    res.status(500).send('Unexpected error while starting Dropbox OAuth.');
  }
}
