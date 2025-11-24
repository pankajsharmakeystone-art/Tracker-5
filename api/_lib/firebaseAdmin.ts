import admin from 'firebase-admin';

const APP_NAME = process.env.FIREBASE_ADMIN_APP_NAME || 'dropbox-session-api';

export type ServiceAccountJSON = admin.ServiceAccount & {
  project_id?: string;
  projectId?: string;
  private_key?: string;
  privateKey?: string;
  client_email?: string;
  clientEmail?: string;
};

let firebaseApp: admin.app.App | null = null;
let firestore: admin.firestore.Firestore | null = null;
let auth: admin.auth.Auth | null = null;
let cachedServiceAccount: ServiceAccountJSON | null = null;

const sanitizeServiceAccount = (raw: string): ServiceAccountJSON => {
  const parsed = JSON.parse(raw) as ServiceAccountJSON;
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    if (!parsed.privateKey) parsed.privateKey = parsed.private_key;
  }
  if (parsed.client_email && !parsed.clientEmail) parsed.clientEmail = parsed.client_email;
  if (parsed.project_id && !parsed.projectId) parsed.projectId = parsed.project_id;
  return parsed;
};

const parseServiceAccount = (): ServiceAccountJSON => {
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

export const ensureAdminUser = async (uid: string) => {
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
