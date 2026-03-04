import React, { useEffect, useRef } from 'react';
import type { AppAlert } from '../types';

interface Props {
    alerts: AppAlert[];
    onDismiss: (id: string) => void;
}

const CATEGORY_BADGE: Record<string, string> = {
    social: '[S]',
    entertainment: '[E]',
    design: '[D]',
    development: '[DEV]',
    communication: '[C]',
    productive: '[P]',
    uncategorized: '[?]',
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

        if (alerts.length > 0 && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => { });
        }

        if (Notification.permission !== 'granted') return;

        alerts.forEach((alert) => {
            if (notified.current.has(alert.id)) return;
            notified.current.add(alert.id);
            try {
                const title = alert.alertType === 'idle_avoid' ? 'Idle Avoid Alert' : 'Red Flag Alert';
                const actor = alert.userDisplayName || 'Agent';
                const target = alert.title || alert.app || 'a flagged app';
                const body = alert.alertType === 'idle_avoid'
                    ? `${actor} showed possible jiggler/idle-avoid activity (${alert.durationSeconds || 0}s)`
                    : `${actor} opened ${target}`;
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
                    <span className="text-xs flex-shrink-0 font-semibold text-gray-500">
                        {CATEGORY_BADGE[alert.category] ?? '[!]'}
                    </span>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-red-600 dark:text-red-400 mb-0.5">
                            {alert.alertType === 'idle_avoid' ? 'Idle Avoid Alert' : 'Red Flag Alert'}
                        </p>
                        <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                            {alert.userDisplayName}
                        </p>
                        <p className="text-xs text-gray-600 dark:text-gray-400 truncate">
                            {alert.alertType === 'idle_avoid'
                                ? <>possible jiggler activity on <span className="font-medium">{alert.title || alert.app}</span></>
                                : <>opened <span className="font-medium">{alert.title || alert.app}</span></>}
                        </p>
                        <p className="text-xs text-gray-400 capitalize mt-0.5">{alert.category}</p>
                    </div>
                    <button
                        onClick={() => onDismiss(alert.id)}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 flex-shrink-0 text-lg leading-none"
                        aria-label="Dismiss"
                    >
                        x
                    </button>
                </div>
            ))}
        </div>
    );
};

export default AppAlertToast;
