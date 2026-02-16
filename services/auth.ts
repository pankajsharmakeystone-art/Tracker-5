
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile,
  type UserCredential,
} from 'firebase/auth';
import { auth } from './firebase';
import { createUserDocument, adminExists } from './db';

// Sign Up - for Admin
export const signUp = async (email: string, password: string, displayName: string): Promise<UserCredential> => {
  const isAdminExisting = await adminExists();
  if (isAdminExisting) {
    throw new Error("An admin account already exists. Please ask your admin for an invitation to join a team.");
  }
  
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    if (userCredential.user) {
      await updateProfile(userCredential.user, { displayName });
      await createUserDocument(userCredential.user, { displayName, role: 'admin' });
    }
    return userCredential;
  } catch (error: any) {
    if (String(error?.message || '').includes('single-admin-enforced')) {
      throw new Error("An admin account already exists. Please ask your admin for an invitation to join a team.");
    }
    throw error;
  }
};

// Sign Up with Invite - for Agents/Managers
export const signUpWithInvite = async (email: string, password: string, displayName: string, teamId: string): Promise<UserCredential> => {
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  if (userCredential.user) {
    await updateProfile(userCredential.user, { displayName });
    await createUserDocument(userCredential.user, { displayName, role: 'agent', teamId });
  }
  return userCredential;
};


// Sign In
export const signIn = (email: string, password: string): Promise<UserCredential> => {
  return signInWithEmailAndPassword(auth, email, password);
};

// Google Sign-In
const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = async (): Promise<UserCredential> => {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    // Note: This flow needs to be adapted for roles.
    // For now, it will create a user document but without a role.
    await createUserDocument(user, { role: 'agent' }); 
    return result;
};


// Logout
export const logout = (): Promise<void> => {
  return signOut(auth);
};

// Password Reset
export const resetPassword = (email: string): Promise<void> => {
  const actionCodeSettings = {
    url: `${window.location.origin}/#/reset-password`,
    handleCodeInApp: true,
  };
  return sendPasswordResetEmail(auth, email, actionCodeSettings);
};

export const verifyResetCode = (code: string) => verifyPasswordResetCode(auth, code);
export const applyResetPassword = (code: string, newPassword: string) => confirmPasswordReset(auth, code, newPassword);
