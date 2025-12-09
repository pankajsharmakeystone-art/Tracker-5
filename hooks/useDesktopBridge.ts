import { useEffect } from 'react';
import { requestDesktopToken } from '../services/desktop';
import { streamGlobalAdminSettings } from '../services/db';
import type { AdminSettingsType } from '../types';

interface DesktopBridgeOptions {
  uid?: string;
}

const useDesktopBridge = ({ uid }: DesktopBridgeOptions) => {
  useEffect(() => {
    if (!uid || typeof window === 'undefined' || !window.desktopAPI) return;

    let canceled = false;
    let unsubscribeSettings: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const safeClearHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const bootstrap = async () => {
      try {
        const token = await requestDesktopToken();
        if (canceled) return;
        if (!window.desktopAPI?.registerUid) return;
        const result = await window.desktopAPI.registerUid({ uid, desktopToken: token });
        if (!result?.success) {
          throw new Error(result?.error || 'desktop-register-failed');
        }
      } catch (error) {
        console.error('[DesktopBridge] Failed to register desktop session:', error);
      }
    };

    bootstrap();

    // Heartbeat: if ping fails, try re-registering to recover the desktop bridge
    heartbeat = setInterval(async () => {
      if (canceled) return;
      try {
        const pong = await window.desktopAPI?.ping?.();
        if (pong !== 'pong') {
          await bootstrap();
        }
      } catch (err) {
        // Backoff after a failure to avoid noisy retries/calls
        safeClearHeartbeat();
        console.warn('[DesktopBridge] ping failed, retrying registration with backoff');
        setTimeout(() => {
          if (canceled) return;
          bootstrap();
          // restart heartbeat after retry
          heartbeat = setInterval(async () => {
            if (canceled) return;
            try {
              const pong = await window.desktopAPI?.ping?.();
              if (pong !== 'pong') {
                await bootstrap();
              }
            } catch {
              safeClearHeartbeat();
              setTimeout(() => {
                if (!canceled) bootstrap();
              }, 30000);
            }
          }, 15000);
        }, 30000);
      }
    }, 15000);

    unsubscribeSettings = streamGlobalAdminSettings((settings: AdminSettingsType | null) => {
      const sync = window.desktopAPI?.syncAdminSettings;
      if (!sync) return;
      sync(settings).catch((error: unknown) => {
        console.error('[DesktopBridge] Failed to sync admin settings to desktop:', error);
      });
    });

    return () => {
      canceled = true;
      safeClearHeartbeat();
      unsubscribeSettings?.();
      window.desktopAPI?.unregisterUid?.();
    };
  }, [uid]);
};

export default useDesktopBridge;
