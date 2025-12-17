import { onValue, ref } from 'firebase/database';
import { rtdb } from './firebase';

export type PresenceEntry = {
  state?: 'online' | 'offline' | 'unknown' | string;
  lastSeen?: number; // RTDB ServerValue.TIMESTAMP resolves to number in snapshots
  sessionId?: string;
  source?: 'desktop' | string;
};

export type PresenceMap = Record<string, PresenceEntry>;

export const streamAllPresence = (callback: (presence: PresenceMap) => void) => {
  const presenceRef = ref(rtdb, 'presence');
  return onValue(
    presenceRef,
    (snapshot) => {
      const val = snapshot.val();
      callback((val && typeof val === 'object' ? (val as PresenceMap) : {}) || {});
    },
    () => {
      callback({});
    }
  );
};

export const isPresenceFresh = (lastSeenMs: number | null | undefined, nowMs: number, maxAgeMs: number) => {
  if (!lastSeenMs || typeof lastSeenMs !== 'number') return false;
  return nowMs - lastSeenMs <= maxAgeMs;
};
