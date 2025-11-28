import admin from 'firebase-admin';

const APP_NAME = process.env.FIREBASE_ADMIN_APP_NAME || 'dropbox-session-api';

let firebaseApp = null;
let firestore = null;
let auth = null;
let cachedServiceAccount = null;

const sanitizeServiceAccount = (raw) => {
  const parsed = JSON.parse(raw);
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    if (!parsed.privateKey) parsed.privateKey = parsed.private_key;
  }
  if (parsed.client_email && !parsed.clientEmail) parsed.clientEmail = parsed.client_email;
  if (parsed.project_id && !parsed.projectId) parsed.projectId = parsed.project_id;
  return parsed;
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

export const getFirebaseServices = () => {
  if (firebaseApp && firestore && auth) {
    return { firestore, auth };
  }

  const serviceAccount = parseServiceAccount();
  const existingApp = admin.apps.find((appInstance) => appInstance?.name === APP_NAME);

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

export const ensureAdminUser = async (uid) => {
  const { firestore: db } = getFirebaseServices();
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) {
    throw new Error('User profile not found');
  }
  const data = userSnap.data();
  if (data?.role !== 'admin') {
    throw new Error('Admin privileges required');
  }
};
