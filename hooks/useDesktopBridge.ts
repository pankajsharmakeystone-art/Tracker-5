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

    unsubscribeSettings = streamGlobalAdminSettings((settings: AdminSettingsType | null) => {
      const sync = window.desktopAPI?.syncAdminSettings;
      if (!sync) return;
      sync(settings).catch((error: unknown) => {
        console.error('[DesktopBridge] Failed to sync admin settings to desktop:', error);
      });
    });

    return () => {
      canceled = true;
      unsubscribeSettings?.();
      window.desktopAPI?.unregisterUid?.();
    };
  }, [uid]);
};

export default useDesktopBridge;
