
import React, { useEffect, useRef } from 'react';
import type { AppAlert } from '../types';

interface Props {
    alerts: AppAlert[];
    onDismiss: (id: string) => void;
}

const CATEGORY_EMOJI: Record<string, string> = {
    social: '💬',
    entertainment: '🎮',
    design: '🎨',
    development: '💻',
    communication: '📧',
    productive: '✅',
    uncategorized: '❓',
};

const AppAlertToast: React.FC<Props> = ({ alerts, onDismiss }) => {
    const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    const notified = useRef<Set<string>>(new Set());

    useEffect(() => {
        alerts.forEach(alert => {
            if (!timers.current[alert.id]) {
                timers.current[alert.id] = setTimeout(() => {
                    onDismiss(alert.id);
                    delete timers.current[alert.id];
                }, 8000);
            }
        });
        // Clean up timers for dismissed alerts
        return () => {
            Object.keys(timers.current).forEach(id => {
                if (!alerts.find(a => a.id === id)) {
                    clearTimeout(timers.current[id]);
                    delete timers.current[id];
                }
            });
        };
    }, [alerts, onDismiss]);

    useEffect(() => {
        if (typeof window === 'undefined' || typeof Notification === 'undefined') return;

        // Request permission once when first alert arrives.
        if (alerts.length > 0 && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => { });
        }

        if (Notification.permission !== 'granted') return;

        alerts.forEach((alert) => {
            if (notified.current.has(alert.id)) return;
            notified.current.add(alert.id);
            try {
                const title = 'Red Flag Alert';
                const actor = alert.userDisplayName || 'Agent';
                const target = alert.title || alert.app || 'a flagged app';
                const body = `${actor} opened ${target}`;
                const n = new Notification(title, { body, tag: `app-alert-${alert.id}` });
                n.onclick = () => {
                    try { window.focus(); } catch (_) { }
                    try { n.close(); } catch (_) { }
                };
            } catch (_) { }
        });
    }, [alerts]);

    if (alerts.length === 0) return null;

    return (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
            {alerts.map(alert => (
                <div
                    key={alert.id}
                    className="pointer-events-auto bg-white dark:bg-gray-900 border-l-4 border-red-500 rounded-lg shadow-xl flex items-start gap-3 p-4 animate-slide-in"
                    role="alert"
                >
                    <span className="text-2xl flex-shrink-0">{CATEGORY_EMOJI[alert.category] ?? '🚨'}</span>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-red-600 dark:text-red-400 mb-0.5">
                            🚨 Red Flag Alert
                        </p>
                        <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                            {alert.userDisplayName}
                        </p>
                        <p className="text-xs text-gray-600 dark:text-gray-400 truncate">
                            opened <span className="font-medium">{alert.title || alert.app}</span>
                        </p>
                        <p className="text-xs text-gray-400 capitalize mt-0.5">{alert.category}</p>
                    </div>
                    <button
                        onClick={() => onDismiss(alert.id)}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 flex-shrink-0 text-lg leading-none"
                        aria-label="Dismiss"
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
};

export default AppAlertToast;
