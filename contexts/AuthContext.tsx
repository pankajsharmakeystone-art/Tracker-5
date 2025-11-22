
import React, { createContext, useState, useEffect, ReactNode } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth } from '../services/firebase';
import { getUserDocument } from '../services/db';
import type { User, AuthContextType, UserData } from '../types';

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
  const [user, setUser] = useState<User>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
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

  const value = { user, userData, loading };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
