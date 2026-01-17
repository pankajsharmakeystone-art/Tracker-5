import { getFunctions, httpsCallable } from 'firebase/functions';
import app from './firebase';

const functions = getFunctions(app, 'us-central1');

export const requestDesktopToken = async (deviceId?: string): Promise<string> => {
  const callable = httpsCallable<{ deviceId?: string }, { token?: string }>(functions, 'issueDesktopToken');
  const result = await callable(deviceId ? { deviceId } : {});
  const token = result.data?.token;
  if (!token) {
    throw new Error('Desktop token missing from callable response');
  }
  return token;
};
