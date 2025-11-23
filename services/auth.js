import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup, updateProfile, } from 'firebase/auth';
import { auth } from './firebase';
import { createUserDocument, adminExists } from './db';
// Sign Up - for Admin
export const signUp = async (email, password, displayName) => {
    const isAdminExisting = await adminExists();
    if (isAdminExisting) {
        throw new Error("An admin account already exists. Please ask your admin for an invitation to join a team.");
    }
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    if (userCredential.user) {
        await updateProfile(userCredential.user, { displayName });
        await createUserDocument(userCredential.user, { displayName, role: 'admin' });
    }
    return userCredential;
};
// Sign Up with Invite - for Agents/Managers
export const signUpWithInvite = async (email, password, displayName, teamId) => {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    if (userCredential.user) {
        await updateProfile(userCredential.user, { displayName });
        await createUserDocument(userCredential.user, { displayName, role: 'agent', teamId });
    }
    return userCredential;
};
// Sign In
export const signIn = (email, password) => {
    return signInWithEmailAndPassword(auth, email, password);
};
// Google Sign-In
const googleProvider = new GoogleAuthProvider();
export const signInWithGoogle = async () => {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;
    // Note: This flow needs to be adapted for roles.
    // For now, it will create a user document but without a role.
    await createUserDocument(user, { role: 'agent' });
    return result;
};
// Logout
export const logout = () => {
    return signOut(auth);
};
// Password Reset
export const resetPassword = (email) => {
    return sendPasswordResetEmail(auth, email);
};
