
import React, { createContext, useState, useEffect, ReactNode } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth } from '../services/firebase';
import { createUserDocument, getUserDocument } from '../services/db';
import type { Role, User, AuthContextType, UserData } from '../types';

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

const isNewUser = (user: FirebaseUser): boolean => {
    if (!user.metadata.creationTime || !user.metadata.lastSignInTime) {
        return false;
    }
    const creationTime = new Date(user.metadata.creationTime).getTime();
    const lastSignInTime = new Date(user.metadata.lastSignInTime).getTime();
    // Consider a new user if the account was created within the last 5 seconds
    return lastSignInTime - creationTime < 5000;
};

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  // Initialize loading to true so the app waits for Firebase before rendering
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      try {
        if (import.meta.env.DEV) {
          console.log('[AuthContext] onAuthStateChanged', currentUser ? { uid: currentUser.uid } : { uid: null });
        }
      } catch {
        // ignore
      }
      // Ensure we are in a loading state while processing the user
      // (Though usually strictly unnecessary inside the callback if init is true, 
      // it helps if auth state changes during a session).
      setLoading(true); 
      
      setUser(currentUser);

      if (currentUser) {
        if (typeof window !== "undefined" && currentUser?.uid) {
          window.currentUserUid = currentUser.uid;
        }
        
        try {
          const fetchUserDataWithRetries = async () => {
            const baseDelayMs = 500;
            for (let attempt = 0; attempt < 4; attempt++) {
              const data = await getUserDocument(currentUser.uid);
              if (data) return data;
              // If it might be a transient error/offline state, retry a few times.
              await sleep(baseDelayMs * (attempt + 1));
            }
            return null;
          };

          let data = await fetchUserDataWithRetries();
          
          // Handle race condition on new user signup where Firestore doc creation might be slightly delayed
          if (!data && isNewUser(currentUser)) {
              // Wait for a short period to allow for Firestore document creation and then retry
              await new Promise(resolve => setTimeout(resolve, 2000));
              data = await fetchUserDataWithRetries();
          }

          // Desktop integration (issueDesktopToken) requires a user profile document.
          // Ensure a minimal user doc exists for accounts created outside the web signup flow.
          if (!data) {
            try {
              const tokenResult = await currentUser.getIdTokenResult();
              const claimedRole = (tokenResult?.claims as any)?.role;
              const role: Role = (claimedRole === 'admin' || claimedRole === 'manager' || claimedRole === 'agent')
                ? claimedRole
                : 'agent';
              await createUserDocument(currentUser, { role });
              data = await fetchUserDataWithRetries();
            } catch (createError) {
              console.error("Failed to create missing user profile:", createError);
            }
          }
          
          setUserData(data);
        } catch (error) {
          console.error("Error fetching user profile:", error);
          setUserData(null);
        }
      } else {
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

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
