import { getFunctions, httpsCallable } from 'firebase/functions';
import app from './firebase';

const functions = getFunctions(app, 'us-central1');

export const requestDesktopToken = async (): Promise<string> => {
  const callable = httpsCallable<{},{ token?: string }>(functions, 'issueDesktopToken');
  const result = await callable({});
  const token = result.data?.token;
  if (!token) {
    throw new Error('Desktop token missing from callable response');
  }
  return token;
};
