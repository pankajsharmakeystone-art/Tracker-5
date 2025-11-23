import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useState, useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../services/firebase';
import { getUserDocument } from '../services/db';
export const AuthContext = createContext(undefined);
const isNewUser = (user) => {
    if (!user.metadata.creationTime || !user.metadata.lastSignInTime) {
        return false;
    }
    const creationTime = new Date(user.metadata.creationTime).getTime();
    const lastSignInTime = new Date(user.metadata.lastSignInTime).getTime();
    // Consider a new user if the account was created within the last 5 seconds
    return lastSignInTime - creationTime < 5000;
};
export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [userData, setUserData] = useState(null);
    // Initialize loading to true so the app waits for Firebase before rendering
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            // Ensure we are in a loading state while processing the user
            // (Though usually strictly unnecessary inside the callback if init is true, 
            // it helps if auth state changes during a session).
            setLoading(true);
            setUser(currentUser);
            if (currentUser) {
                if (typeof window !== "undefined" && currentUser?.uid) {
                    window.currentUserUid = currentUser.uid;
                    window.desktopAPI?.registerUid?.(currentUser.uid);
                }
                try {
                    let data = await getUserDocument(currentUser.uid);
                    // Handle race condition on new user signup where Firestore doc creation might be slightly delayed
                    if (!data && isNewUser(currentUser)) {
                        // Wait for a short period to allow for Firestore document creation and then retry
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        data = await getUserDocument(currentUser.uid);
                    }
                    setUserData(data);
                }
                catch (error) {
                    console.error("Error fetching user profile:", error);
                    setUserData(null);
                }
            }
            else {
                setUserData(null);
            }
            // Only set loading to false after all async operations are complete
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);
    const logout = async () => {
        await auth.signOut();
    };
    const value = { currentUser: user, user, userData, loading, logout };
    return (_jsx(AuthContext.Provider, { value: value, children: children }));
};
