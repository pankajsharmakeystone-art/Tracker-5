import { useEffect, useRef } from 'react';
import { enableNetwork, disableNetwork } from 'firebase/firestore';
import { auth, db } from '../services/firebase';

const RECOVERY_COOLDOWN_MS = 30_000;
const NETWORK_TOGGLE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const refreshAuthToken = async () => {
  const user = auth.currentUser;
  if (!user) return;
  await user.getIdToken(true);
};

const bounceFirestoreNetwork = async () => {
  try {
    await disableNetwork(db);
    await sleep(NETWORK_TOGGLE_DELAY_MS);
    await enableNetwork(db);
  } catch (err) {
    console.warn('[WebRecoveryWatchdog] Failed to bounce Firestore network', err);
  }
};

const redirectToLogin = async () => {
  try {
    await auth.signOut();
  } catch {
    // ignore
  }

  try {
    if (typeof window !== 'undefined') {
      window.location.hash = '#/login';
      window.location.reload();
    }
  } catch {
    // ignore
  }
};

const useWebRecoveryWatchdog = () => {
  const lastRunRef = useRef(0);

  useEffect(() => {
    let canceled = false;
    const isDesktopShell = typeof window !== 'undefined' && Boolean((window as any)?.desktopAPI);

    const trigger = async (reason: string) => {
      if (canceled) return;
      const now = Date.now();
      if (now - lastRunRef.current < RECOVERY_COOLDOWN_MS) return;
      lastRunRef.current = now;

      try {
        await refreshAuthToken();
      } catch (err) {
        console.warn('[WebRecoveryWatchdog] Token refresh failed, attempting recovery', { reason, err });
        await bounceFirestoreNetwork();
        try {
          await refreshAuthToken();
        } catch (retryErr) {
          console.warn('[WebRecoveryWatchdog] Token refresh failed after recovery', { reason, err: retryErr });

          // In Electron/Desktop, avoid forcing a sign-out loop. Desktop has its own recovery paths
          // (re-register + watchdog) and a forced redirect to login makes the UX much worse.
          if (isDesktopShell) return;

          await redirectToLogin();
          return;
        }
      }

      await bounceFirestoreNetwork();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        trigger('visibility');
      }
    };

    const onFocus = () => trigger('focus');
    const onOnline = () => trigger('online');

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);

    // Run once on mount to normalize state after hot reloads.
    trigger('mount');

    return () => {
      canceled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, []);
};

export default useWebRecoveryWatchdog;
