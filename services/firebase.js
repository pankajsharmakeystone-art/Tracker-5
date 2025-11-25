import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const env = typeof import.meta !== 'undefined' && import.meta?.env
    ? import.meta.env
    : (typeof process !== 'undefined' ? process.env : {});

const firebaseConfig = {
    apiKey: env?.VITE_FIREBASE_API_KEY ?? '',
    authDomain: env?.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: env?.VITE_FIREBASE_PROJECT_ID ?? '',
    storageBucket: env?.VITE_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: env?.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: env?.VITE_FIREBASE_APP_ID ?? ''
};

const missingFields = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

if (missingFields.length) {
    throw new Error(`Missing Firebase config values: ${missingFields.join(', ')}. Check your environment variables.`);
}
// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
