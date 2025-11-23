import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
const firebaseConfig = {
    apiKey: "AIzaSyD5vZus2htyyVjshJsoPpS_oGXHY9Y1nC8",
    authDomain: "tracker-5.firebaseapp.com",
    projectId: "tracker-5",
    storageBucket: "tracker-5.appspot.com",
    messagingSenderId: "999617089652",
    appId: "1:999617089652:web:638808d56c1080557d8121"
};
// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;
