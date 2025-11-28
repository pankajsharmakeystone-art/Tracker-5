export const DROPBOX_SESSIONS_COLLECTION = 'dropboxOauthSessions';

export const isSessionRecent = (timestamp, maxMinutes = 15) => {
  if (!timestamp) return false;
  const created = timestamp.toDate().getTime();
  return Date.now() - created < maxMinutes * 60 * 1000;
};

export const inferExternalBaseUrl = (req) => {
  if (process.env.DROPBOX_OAUTH_BASE_URL) {
    return process.env.DROPBOX_OAUTH_BASE_URL.replace(/\/$/, '');
  }
  if (req) {
    const protoHeader = req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'];
    const protocol = Array.isArray(protoHeader)
      ? protoHeader[0]
      : protoHeader?.split(',')[0] || (req.connection && 'encrypted' in req.connection ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) {
      return `${protocol || 'https'}://${host}`;
    }
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/$/, '')}`;
  }
  return 'http://localhost:3000';
};

export const buildCallbackUrl = (req) => {
  return `${inferExternalBaseUrl(req)}/api/dropbox-callback`;
};
