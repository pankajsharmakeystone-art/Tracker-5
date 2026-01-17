import { useEffect } from 'react';
import { requestDesktopToken } from '../services/desktop';
import { logout } from '../services/auth';
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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let isRegistered = false;
    let retryDelayMs = 3000;

    const safeClearHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const safeClearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleRetry = () => {
      if (canceled) return;
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void bootstrap();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 30000);
    };

    const getOrCreateDeviceId = (): string | null => {
      try {
        const key = 'desktop-device-id';
        let id = localStorage.getItem(key);
        if (!id) {
          const randomUuid = (globalThis as any)?.crypto?.randomUUID?.();
          id = randomUuid || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
          localStorage.setItem(key, id);
        }
        return id;
      } catch {
        return null;
      }
    };

    const isLoginBlockedError = (error: any) => {
      const code = String(error?.code || '').toLowerCase();
      if (code.includes('failed-precondition')) return true;
      const message = String(error?.message || '').toLowerCase();
      return message.includes('already logged in');
    };

    const bootstrap = async () => {
      try {
        safeClearRetry();
        const deviceId = getOrCreateDeviceId();
        const token = await requestDesktopToken(deviceId ?? undefined);
        if (canceled) return;
        if (!window.desktopAPI?.registerUid) return;
        const result = await window.desktopAPI.registerUid({ uid, desktopToken: token, deviceId: deviceId || undefined });
        if (!result?.success) {
          throw new Error(result?.error || 'desktop-register-failed');
        }
        isRegistered = true;
        retryDelayMs = 3000;
      } catch (error) {
        console.error('[DesktopBridge] Failed to register desktop session:', error);
        isRegistered = false;
        if (isLoginBlockedError(error)) {
          const message = 'You are already logged in on another machine. Please log out there first, then sign in here.';
          try {
            localStorage.setItem('desktop-login-blocked-message', message);
          } catch {
            // ignore
          }
          try {
            await logout();
          } catch {
            // ignore
          }
          try {
            window.location.hash = '#/login';
          } catch {
            // ignore
          }
          canceled = true;
          safeClearRetry();
          safeClearHeartbeat();
          return;
        }
        scheduleRetry();
      }
    };

    bootstrap();

    window.desktopAPI?.onRegistered?.(() => {
      isRegistered = true;
      retryDelayMs = 3000;
      safeClearRetry();
    });

    const unsubscribeAuthRequired = window.desktopAPI?.onAuthRequired?.(({ reason }: { reason?: string } = {}) => {
      console.warn('[DesktopBridge] desktop auth required', { reason });
      isRegistered = false;
      retryDelayMs = 3000;
      safeClearRetry();
      void bootstrap();
    });

    // Heartbeat: if ping fails, try re-registering to recover the desktop bridge
    heartbeat = setInterval(async () => {
      if (canceled) return;
      try {
        if (!isRegistered) {
          await bootstrap();
          return;
        }
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
      safeClearRetry();
      unsubscribeSettings?.();
      try {
        if (typeof unsubscribeAuthRequired === 'function') unsubscribeAuthRequired();
      } catch {
        // ignore
      }
      window.desktopAPI?.unregisterUid?.();
    };
  }, [uid]);
};

export default useDesktopBridge;
