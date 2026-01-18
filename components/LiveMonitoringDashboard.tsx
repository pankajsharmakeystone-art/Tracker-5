
import React, { useState, useEffect, useMemo } from 'react';
import { Timestamp } from 'firebase/firestore';
import { DateTime } from 'luxon';
import { streamTodayWorkLogs, streamWorkLogsForDate, isSessionStale, closeStaleSession, updateWorkLog, readOrganizationTimezone, forceLogoutAgent, requestDesktopReconnect, streamAllAgentStatuses } from '../services/db';
import { streamAllPresence, isPresenceFresh } from '../services/presence';
import { useAuth } from '../hooks/useAuth';
import type { WorkLog } from '../types';
import Spinner from './Spinner';
import LiveStreamModal from './LiveStreamModal';
import ActivitySheet from './ActivitySheet';

interface Props {
    teamId?: string;
}

const formatDuration = (totalSeconds: number): string => {
    if (totalSeconds < 0) totalSeconds = 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return [hours, minutes, seconds]
        .map(v => v.toString().padStart(2, '0'))
        .join(':');
};

const toDateSafe = (value: any): Date | null => {
    if (!value) return null;
    try {
        if (value instanceof Timestamp) return value.toDate();
        if (typeof value.toDate === 'function') return value.toDate();
        if (value instanceof Date) return value;
        if (typeof value === 'number') return new Date(value);
        return null;
    } catch {
        return null;
    }
};

const formatDateTime = (timestamp: Timestamp | null | undefined, timezone?: string): string => {
    const date = toDateSafe(timestamp);
    if (!date) return 'N/A';
    const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return DateTime.fromJSDate(date).setZone(zone, { keepLocalTime: false }).toFormat('MM/dd, hh:mm a');
};

// Helper for datetime-local input
const toDatetimeLocal = (timestamp: Timestamp | null | undefined) => {
    if (!timestamp) return '';
    const d = timestamp.toDate();
    const pad = (n: number) => n.toString().padStart(2, '0');
    // Includes seconds for precision editing
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const getMillis = (value: any): number | null => {
    if (!value) return null;
    try {
        if (value instanceof Timestamp) return value.toMillis();
        if (typeof value.toMillis === 'function') return value.toMillis();
        if (typeof value.toDate === 'function') return value.toDate().getTime();
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return value;
    } catch (error) {
        console.warn('[LiveMonitoringDashboard] Failed to normalize timestamp', error);
    }
    return null;
};

const normalizeBreakCause = (entry: any): 'manual' | 'idle' => {
    const raw = (entry?.cause || entry?.reason || entry?.type || entry?.source || '').toString().toLowerCase();
    if (raw.includes('idle')) return 'idle';
    if (entry?.auto === true || entry?.isIdle === true) return 'idle';
    return 'manual';
};

const aggregateBreakSeconds = (log: WorkLog, nowMs: number) => {
    const breaks = Array.isArray((log as any)?.breaks) ? (log as any).breaks : [];
    let manualSeconds = 0;
    let idleSeconds = 0;
    let accounted = false;

    // When session is clocked out, don't add any live elapsed time
    const isClockedOut = log.status === 'clocked_out';
    // Use lastEventTimestamp as the cutoff for clocked out sessions
    const cutoffMs = isClockedOut
        ? (getMillis(log.lastEventTimestamp as any) ?? nowMs)
        : nowMs;

    breaks.forEach((entry: any) => {
        const startMs = getMillis(entry?.startTime);
        if (startMs == null) return;
        const endMs = entry?.endTime ? getMillis(entry.endTime) : null;
        // For open breaks, use cutoff (lastEvent for clocked out, now for active)
        const effectiveEnd = endMs ?? cutoffMs;
        if (effectiveEnd <= startMs) return;
        accounted = true;
        const duration = (effectiveEnd - startMs) / 1000;
        if (normalizeBreakCause(entry) === 'idle') idleSeconds += duration;
        else manualSeconds += duration;
    });

    if (!accounted) {
        manualSeconds = typeof log.totalBreakSeconds === 'number' ? log.totalBreakSeconds : 0;
        const isOnBreak = log.status === 'on_break' || (log.status as any) === 'break';
        const lastEventMs = getMillis(log.lastEventTimestamp as any);
        // Only add live elapsed if actively on break (not clocked out)
        if (isOnBreak && !isClockedOut && lastEventMs != null && nowMs > lastEventMs) {
            manualSeconds += (nowMs - lastEventMs) / 1000;
        }
    }

    return { manualSeconds, idleSeconds };
};

const OVERNIGHT_THRESHOLD_MINUTES = 12 * 60;

const calculateLateMinutes = (
    scheduledStart?: string | null,
    startDate?: Date | null,
    timezone?: string,
    isOvernightShift?: boolean
) => {
    if (!scheduledStart || !startDate) return 0;
    try {
        const [hour, minute] = scheduledStart.split(':').map(Number);
        if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
        const zone = timezone || 'UTC';
        const actual = DateTime.fromJSDate(startDate).setZone(zone, { keepLocalTime: false });
        const scheduledSameDay = actual.set({ hour, minute, second: 0, millisecond: 0 });

        if (actual < scheduledSameDay) {
            if (!isOvernightShift) return 0;
            const leadMinutes = scheduledSameDay.diff(actual, 'minutes').minutes;
            if (leadMinutes <= OVERNIGHT_THRESHOLD_MINUTES) return 0;
            const previousDayStart = scheduledSameDay.minus({ days: 1 });
            return Math.max(0, actual.diff(previousDayStart, 'minutes').minutes);
        }

        return Math.max(0, actual.diff(scheduledSameDay, 'minutes').minutes);
    } catch {
        return 0;
    }
};

const deriveLateMinutesForLog = (log: WorkLog, timezone?: string): number | null => {
    if (!log?.scheduledStart) return null;
    const startDate = toDateSafe(log.clockInTime ?? log.startTime);
    if (!startDate) return null;
    const late = calculateLateMinutes(
        log.scheduledStart,
        startDate,
        timezone,
        log.isOvernightShift === true
    );
    if (!Number.isFinite(late)) return null;
    return Math.round(late);
};

const EditTimeModal = ({ log, onClose, timezone }: { log: WorkLog, onClose: () => void, timezone: string }) => {
    const [startTime, setStartTime] = useState(toDatetimeLocal(log.clockInTime));
    const [endTime, setEndTime] = useState(toDatetimeLocal(log.clockOutTime));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const effectiveTimezone = timezone || 'UTC';

    const handleSave = async () => {
        if (!startTime) {
            setError("Clock In time is required.");
            return;
        }

        const startDate = new Date(startTime);
        let endDate = endTime ? new Date(endTime) : null;

        if (endDate && endDate <= startDate) {
            const DAY_MS = 24 * 60 * 60 * 1000;
            let adjusted = endDate;
            while (adjusted <= startDate) {
                adjusted = new Date(adjusted.getTime() + DAY_MS);
            }
            endDate = adjusted;
        }

        setSaving(true);
        setError(null);

        try {
            const updates: any = {
                clockInTime: Timestamp.fromDate(startDate),
                clockOutTime: endDate ? Timestamp.fromDate(endDate) : null,
            };

            const closeLastOpenActivity = (activities: any[] | undefined, end: Date) => {
                if (!Array.isArray(activities) || !end) return undefined;
                const copy = activities.map((a) => ({ ...a }));
                for (let i = copy.length - 1; i >= 0; i -= 1) {
                    if (!copy[i]?.endTime) {
                        copy[i] = { ...copy[i], endTime: Timestamp.fromDate(end) };
                        return copy;
                    }
                }
                return undefined;
            };

            const newStartMillis = startDate.getTime();
            const newEndMillis = endDate ? endDate.getTime() : Date.now();

            // Recalculate Valid Break Seconds
            // We must only count breaks that fall WITHIN the new start/end times.
            let newTotalBreakSeconds = 0;

            if (log.breaks && log.breaks.length > 0) {
                log.breaks.forEach(b => {
                    const bStart = b.startTime.toDate().getTime();
                    const bEnd = b.endTime ? b.endTime.toDate().getTime() : Date.now();

                    // Find intersection of [bStart, bEnd] with [newStart, newEnd]
                    const overlapStart = Math.max(bStart, newStartMillis);
                    const overlapEnd = Math.min(bEnd, newEndMillis);

                    if (overlapEnd > overlapStart) {
                        newTotalBreakSeconds += (overlapEnd - overlapStart) / 1000;
                    }
                });
            }

            const totalElapsedSeconds = (newEndMillis - newStartMillis) / 1000;
            const newTotalWorkSeconds = Math.max(0, totalElapsedSeconds - newTotalBreakSeconds);

            updates.totalWorkSeconds = newTotalWorkSeconds;
            updates.totalBreakSeconds = newTotalBreakSeconds;

            if (log.scheduledStart) {
                updates.lateMinutes = calculateLateMinutes(
                    log.scheduledStart,
                    startDate,
                    effectiveTimezone,
                    log.isOvernightShift === true
                );
            }

            // If we are setting an end time, ensure status is clocked_out
            if (endDate) {
                updates.status = 'clocked_out';
                const updatedActivities = closeLastOpenActivity((log as any).activities, endDate);
                if (updatedActivities) {
                    updates.activities = updatedActivities;
                }
            } else if (log.status === 'clocked_out' && !endDate) {
                // If we are clearing the end time, set back to working
                updates.status = 'working';
            }

            await updateWorkLog(log.id, updates);
            onClose();
        } catch (e) {
            console.error(e);
            setError("Failed to update time logs.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" aria-modal="true" role="dialog">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl w-full max-w-md border dark:border-gray-700">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Edit Time Log</h3>

                {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

                <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Clock In Time</label>
                    <input
                        type="datetime-local"
                        value={startTime}
                        onChange={(e) => setStartTime(e.target.value)}
                        step="1"
                        className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                </div>

                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Clock Out Time</label>
                    <input
                        type="datetime-local"
                        value={endTime}
                        onChange={(e) => setEndTime(e.target.value)}
                        step="1"
                        className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Leave empty to keep session active. Overnight shifts will automatically roll into the next day.</p>
                </div>

                <div className="flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        disabled={saving}
                        className="px-4 py-2 text-gray-700 bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-4 py-2 text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                        {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </div>
    );
};

const TimeEntriesModal = ({ log, onClose, timezone }: { log: WorkLog; onClose: () => void, timezone: string }) => {
    const readableDate = log?.date?.toDate ? log.date.toDate().toLocaleDateString() : 'N/A';

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" aria-modal="true" role="dialog">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col border dark:border-gray-700">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">Time Entries</h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400">{log.userDisplayName}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">Session Date: {readableDate}</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="px-3 py-1 text-sm text-gray-600 bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
                    >
                        Close
                    </button>
                </div>
                <div className="mt-4 overflow-y-auto pr-1">
                    <ActivitySheet workLog={log} timezone={timezone} />
                </div>
            </div>
        </div>
    );
};

const LiveMonitoringDashboard: React.FC<Props> = ({ teamId }) => {
    const { userData } = useAuth();
    const [rawLogs, setRawLogs] = useState<WorkLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [agentStatuses, setAgentStatuses] = useState<Record<string, any>>({});
    const [presence, setPresence] = useState<Record<string, any>>({});
    const [editingLog, setEditingLog] = useState<WorkLog | null>(null);
    const [viewingLog, setViewingLog] = useState<WorkLog | null>(null);
    const [liveStreamAgent, setLiveStreamAgent] = useState<{ uid: string; displayName: string; teamId?: string } | null>(null);
    const [isLiveModalOpen, setIsLiveModalOpen] = useState(false);
    const [organizationTimezone, setOrganizationTimezone] = useState<string>('UTC');
    const [forceLogoutPending, setForceLogoutPending] = useState<string | null>(null);
    const [reconnectPending, setReconnectPending] = useState<string | null>(null);
    const reconnectRequestRef = React.useRef<{ uid: string; requestId: string } | null>(null);
    const reconnectTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const [selectedDate, setSelectedDate] = useState(() => {
        const d = new Date();
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    });

    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        let mounted = true;
        readOrganizationTimezone()
            .then((tz) => { if (mounted && tz) setOrganizationTimezone(tz); })
            .catch(() => {/* ignore */ });
        return () => { mounted = false; };
    }, []);

    const isToday = useMemo(() => {
        const d = new Date();
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const todayStr = `${year}-${month}-${day}`;
        return selectedDate === todayStr;
    }, [selectedDate]);

    useEffect(() => {
        setLoading(true);
        let unsubscribe;
        const unsubscribeStatuses = streamAllAgentStatuses((statuses) => setAgentStatuses(statuses || {}));
        const unsubscribePresence = streamAllPresence((p) => setPresence(p || {}));

        if (isToday) {
            // Queries for: Today's logs + ANY active logs (including yesterday's)
            unsubscribe = streamTodayWorkLogs((logs) => {
                setRawLogs(logs);
                setLoading(false);
            }, teamId);
        } else {
            // Historical view: strict date query
            unsubscribe = streamWorkLogsForDate(selectedDate, (logs) => {
                setRawLogs(logs);
                setLoading(false);
            }, teamId);
        }

        return () => {
            if (unsubscribe) unsubscribe();
            if (unsubscribeStatuses) unsubscribeStatuses();
            if (unsubscribePresence) unsubscribePresence();
        };
    }, [teamId, selectedDate, isToday]);

    // Calculate live values
    const normalizeStatus = (raw: any): WorkLog['status'] => {
        const val = String(raw || '').toLowerCase();
        if (val === 'working' || val === 'online' || val === 'active') return 'working';
        if (val === 'on_break' || val === 'break') return 'on_break';
        return 'clocked_out';
    };

    const agents = useMemo(() => {
        return rawLogs.map(log => {
            const desktopStatus = agentStatuses?.[log.userId];
            const presenceEntry = presence?.[log.userId];
            const isStale = false; // show the Firestore status as-is; no stale override
            const isActive = log.status !== 'clocked_out';
            const isZombie = isSessionStale(log) && isActive;

            const { manualSeconds, idleSeconds } = aggregateBreakSeconds(log, now);
            const totalBreak = manualSeconds + idleSeconds;

            let totalWork = log.totalWorkSeconds;

            // For closed sessions, always calculate from server timestamps to avoid
            // issues with incorrect client clocks. clockInTime and clockOutTime are
            // server timestamps and thus always accurate.
            if (!isActive) {
                const clockInMs = getMillis(log.clockInTime);
                const clockOutMs = getMillis(log.clockOutTime);
                if (clockInMs && clockOutMs && clockOutMs > clockInMs) {
                    const totalSessionSeconds = (clockOutMs - clockInMs) / 1000;
                    totalWork = Math.max(0, totalSessionSeconds - totalBreak);
                }
            } else if (!isZombie && log.lastEventTimestamp) {
                // For active sessions, add live elapsed time (real-time display)
                const lastTime = (log.lastEventTimestamp as any).toMillis
                    ? (log.lastEventTimestamp as any).toMillis()
                    : (log.lastEventTimestamp as any).toDate().getTime();

                const elapsed = Math.max(0, (now - lastTime) / 1000);

                // Only count work time if status is 'working' AND not idle/on manual break
                // This ensures mutual exclusivity between work/idle/break counters
                const isAgentIdle = desktopStatus?.isIdle === true;
                const isAgentOnManualBreak = desktopStatus?.manualBreak === true;
                if (log.status === 'working' && !isAgentIdle && !isAgentOnManualBreak) {
                    totalWork += elapsed;
                }
            }

            // Check if this log started on a previous day
            let isOvernight = false;
            if (log.date) {
                const logDate = (log.date as any).toDate();
                const selected = new Date(selectedDate);
                // Basic check: if log date is before selected viewing date (which is usually today)
                if (logDate.setHours(0, 0, 0, 0) < selected.setHours(0, 0, 0, 0)) {
                    isOvernight = true;
                }
            }

            const computedLateMinutes = deriveLateMinutesForLog(log, organizationTimezone);
            const lateMinutes = typeof computedLateMinutes === 'number'
                ? computedLateMinutes
                : (typeof log.lateMinutes === 'number' ? Math.round(log.lateMinutes) : 0);

            // Status must come from worklogs only (single source of truth).
            const effectiveStatus: WorkLog['status'] = normalizeStatus(log.status);

            return {
                ...log,
                status: effectiveStatus,
                displayWork: totalWork,
                displayBreak: totalBreak,
                manualBreakSeconds: manualSeconds,
                idleBreakSeconds: idleSeconds,
                isZombie,
                isOvernight,
                lateMinutes,
                __desktop: {
                    isStale,
                    // Strict "Desktop connected": RTDB presence only.
                    // Heartbeat is every 5 minutes; allow a small grace window.
                    isConnected: (
                        presenceEntry?.source === 'desktop'
                        && presenceEntry?.state === 'online'
                        && isPresenceFresh(presenceEntry?.lastSeen, now, 7 * 60 * 1000)
                    ),
                    isRecording: desktopStatus?.isRecording === true
                }
            };
        });
    }, [rawLogs, now, selectedDate, organizationTimezone, agentStatuses, presence]);

    const handleForceClose = async (log: WorkLog) => {
        if (window.confirm("Force close this session? This marks it as clocked out at the last active time.")) {
            await closeStaleSession(log);
        }
    };

    const managerTeamIds = useMemo(() => {
        if (!userData) return [] as string[];
        if (Array.isArray(userData.teamIds) && userData.teamIds.length > 0) return userData.teamIds;
        return userData.teamId ? [userData.teamId] : [];
    }, [userData]);

    const canRequestStreamForAgent = (log: WorkLog) => {
        if (!log || log.status === 'clocked_out' || !userData) return false;
        if (userData.role === 'admin') return true;
        if (userData.role === 'manager' && log.teamId) {
            return managerTeamIds.includes(log.teamId);
        }
        return false;
    };

    const canForceLogoutAgent = (log: WorkLog) => {
        if (!log?.userId || !userData) return false;
        if (userData.role === 'admin') return true;
        if (userData.role === 'manager' && log.teamId) {
            return managerTeamIds.includes(log.teamId);
        }
        return false;
    };

    const handleLiveStream = (log: WorkLog) => {
        if (!log?.userId || !canRequestStreamForAgent(log)) return;
        setLiveStreamAgent({ uid: log.userId, displayName: log.userDisplayName, teamId: log.teamId });
        setIsLiveModalOpen(true);
    };

    const handleForceLogoutAgent = async (log: WorkLog) => {
        if (!canForceLogoutAgent(log)) return;
        if (!log?.userId) return;
        if (log.status === 'clocked_out') return;
        const confirmation = window.confirm(`Force logout ${log.userDisplayName || 'this agent'}? This will clock them out immediately and disconnect their desktop app.`);
        if (!confirmation) return;
        setForceLogoutPending(log.userId);
        try {
            await forceLogoutAgent(log.userId);
        } catch (error) {
            console.error('[LiveMonitoringDashboard] Failed to force logout agent', error);
            alert('Failed to force logout agent. Please try again or contact support.');
        } finally {
            setForceLogoutPending(null);
        }
    };

    const handleReconnectDesktop = async (log: WorkLog) => {
        if (!canForceLogoutAgent(log)) return;
        if (!log?.userId) return;
        setReconnectPending(log.userId);
        try {
            const requestId = await requestDesktopReconnect(log.userId);
            if (!requestId) return;
            reconnectRequestRef.current = { uid: log.userId, requestId };

            // Implicit "ping": if no ack arrives soon, treat desktop as offline/unresponsive.
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            reconnectTimeoutRef.current = setTimeout(() => {
                const pending = reconnectRequestRef.current;
                if (!pending || pending.uid !== log.userId || pending.requestId !== requestId) return;
                setReconnectPending(null);
                reconnectRequestRef.current = null;
                reconnectTimeoutRef.current = null;
                alert('Desktop appears offline or not responding.');
            }, 10000);
        } catch (error) {
            console.error('[LiveMonitoringDashboard] Failed to request desktop reconnect', error);
            alert('Failed to request desktop reconnect. Please try again.');
        } finally {
            // Cleared when ack arrives or timeout triggers.
        }
    };

    useEffect(() => {
        const pending = reconnectRequestRef.current;
        if (!pending) return;
        if (reconnectPending !== pending.uid) return;
        const status = agentStatuses?.[pending.uid];
        if (status?.reconnectAckId && status.reconnectAckId === pending.requestId) {
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            reconnectRequestRef.current = null;
            setReconnectPending(null);
            alert('Reconnect successful.');
        }
    }, [agentStatuses, reconnectPending]);

    const closeLiveStreamModal = () => {
        setIsLiveModalOpen(false);
        setLiveStreamAgent(null);
    };

    const getStatusBadge = (agent: any) => {
        if (agent.isZombie) {
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 animate-pulse">Stale / Zombie</span>;
        }
        switch (agent.status) {
            case 'working':
                return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Working</span>;
            case 'on_break':
            case 'break':
                return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">On Break</span>;
            case 'clocked_out':
                return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200">Offline</span>;
            default:
                return null;
        }
    };

    const getRecordingIndicator = (meta: { isConnected?: boolean; isRecording?: boolean; status?: WorkLog['status']; isStale?: boolean }) => {
        const { isConnected, isRecording, status, isStale } = meta;
        const agentState = status;

        if (!isConnected || agentState === 'clocked_out' || isStale) {
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200">Rec Off</span>;
        }

        if (isRecording) {
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Rec On</span>;
        }
        return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200">Rec Off</span>;
    };

    if (loading && !rawLogs.length) return <div className="p-8 flex justify-center"><Spinner /></div>;

    return (
        <>
            {isLiveModalOpen && liveStreamAgent && (
                <LiveStreamModal
                    isOpen={isLiveModalOpen}
                    agent={liveStreamAgent}
                    onClose={closeLiveStreamModal}
                />
            )}
            {editingLog && (
                <EditTimeModal
                    log={editingLog}
                    onClose={() => setEditingLog(null)}
                    timezone={organizationTimezone}
                />
            )}
            {viewingLog && (
                <TimeEntriesModal
                    log={viewingLog}
                    onClose={() => setViewingLog(null)}
                    timezone={organizationTimezone}
                />
            )}

            <div className="mb-4 flex flex-col sm:flex-row justify-between items-center gap-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border dark:border-gray-700">
                <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                    Monitoring
                </h3>
                <div className="flex items-center gap-2">
                    <label htmlFor="monitor-date" className="text-sm font-medium text-gray-700 dark:text-gray-300">Date:</label>
                    <input
                        type="date"
                        id="monitor-date"
                        value={selectedDate}
                        onChange={(e) => setSelectedDate(e.target.value)}
                        className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                    />
                </div>
            </div>

            <div className="overflow-x-auto relative shadow-md sm:rounded-lg">
                <table className="w-full text-sm text-left text-gray-500 dark:text-gray-400">
                    <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
                        <tr>
                            <th scope="col" className="py-3 px-6">Agent</th>
                            <th scope="col" className="py-3 px-6">Status</th>
                            <th scope="col" className="py-3 px-6">Shift Info</th>
                            <th scope="col" className="py-3 px-6 text-center">Clock In</th>
                            <th scope="col" className="py-3 px-6 text-center">Clock Out</th>
                            <th scope="col" className="py-3 px-6">Work Duration</th>
                            <th scope="col" className="py-3 px-6">Manual Break</th>
                            <th scope="col" className="py-3 px-6">Idle Break</th>
                            <th scope="col" className="py-3 px-6 text-center">Recorder</th>
                            <th scope="col" className="py-3 px-6">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {agents.length > 0 ? agents.map(agent => (
                            <tr key={agent.id} className={`bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 ${agent.isOvernight ? 'bg-purple-50 dark:bg-purple-900/20' : ''}`}>
                                <td className="py-4 px-6 font-medium text-gray-900 whitespace-nowrap dark:text-white">
                                    {agent.userDisplayName}
                                    {agent.isOvernight && <div className="text-xs text-purple-600 dark:text-purple-400">Previous Day Start</div>}
                                </td>
                                <td className="py-4 px-6">{getStatusBadge(agent)}</td>
                                <td className="py-4 px-6">
                                    {(agent.lateMinutes ?? 0) > 0 ? (
                                        <span className="text-red-600 font-bold">{agent.lateMinutes ?? 0} min Late</span>
                                    ) : (
                                        <span className="text-green-600">On Time</span>
                                    )}
                                </td>
                                <td className="py-4 px-6 text-center font-mono whitespace-nowrap text-xs">
                                    {formatDateTime(agent.clockInTime, organizationTimezone)}
                                </td>
                                <td className="py-4 px-6 text-center font-mono whitespace-nowrap text-xs">
                                    {agent.status === 'clocked_out' ? (
                                        formatDateTime(agent.clockOutTime, organizationTimezone)
                                    ) : (
                                        <span className="text-blue-500 animate-pulse">Active...</span>
                                    )}
                                </td>
                                <td className="py-4 px-6 font-mono font-bold text-gray-700 dark:text-gray-200">
                                    {formatDuration(agent.displayWork)}
                                </td>
                                <td className="py-4 px-6 font-mono text-gray-700 dark:text-gray-200">
                                    {formatDuration(agent.manualBreakSeconds ?? agent.displayBreak)}
                                </td>
                                <td className="py-4 px-6 font-mono text-gray-600 dark:text-gray-300">
                                    {formatDuration(agent.idleBreakSeconds ?? 0)}
                                </td>
                                <td className="py-4 px-6 text-center">
                                    {getRecordingIndicator({
                                        isConnected: agent.__desktop?.isConnected,
                                        isRecording: agent.__desktop?.isRecording,
                                        status: agent.status,
                                        isStale: agent.__desktop?.isStale
                                    })}
                                </td>
                                <td className="py-4 px-6 flex gap-2 items-center">
                                    <button
                                        onClick={() => setViewingLog(agent)}
                                        className="font-medium text-sky-600 dark:text-sky-400 hover:underline"
                                        title="View detailed time entries"
                                    >
                                        Logs
                                    </button>
                                    <button
                                        onClick={() => setEditingLog(agent)}
                                        className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                                        title="Edit Time Log"
                                    >
                                        Edit
                                    </button>
                                    {canRequestStreamForAgent(agent) && (
                                        <button
                                            onClick={() => handleLiveStream(agent)}
                                            className="font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                            title="Request Live Screen"
                                        >
                                            Live
                                        </button>
                                    )}
                                    {(agent.isZombie || (agent.status !== 'clocked_out' && !isToday)) && (
                                        <button
                                            onClick={() => handleForceClose(agent)}
                                            className="font-medium text-red-600 dark:text-red-400 hover:underline"
                                            title="Force Close Session"
                                        >
                                            Close
                                        </button>
                                    )}
                                    {canForceLogoutAgent(agent) && agent.__desktop?.isConnected && (
                                        <button
                                            onClick={() => handleReconnectDesktop(agent)}
                                            disabled={reconnectPending === agent.userId}
                                            className="font-medium text-amber-600 dark:text-amber-400 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                                            title="Ask the desktop app to re-connect if it's stuck"
                                        >
                                            Reconnect
                                        </button>
                                    )}
                                    {canForceLogoutAgent(agent) && agent.status !== 'clocked_out' && (
                                        <button
                                            onClick={() => handleForceLogoutAgent(agent)}
                                            disabled={forceLogoutPending === agent.userId}
                                            className={`w-3.5 h-3.5 rounded-full border border-red-500 bg-red-500/90 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-red-500 transition disabled:opacity-50 disabled:cursor-not-allowed`}
                                            title="Force Logout"
                                            aria-label="Force Logout"
                                        >
                                            <span className="sr-only">Force Logout</span>
                                        </button>
                                    )}
                                </td>
                            </tr>
                        )) : (
                            <tr>
                                <td colSpan={10} className="py-4 px-6 text-center text-gray-500 dark:text-gray-400">
                                    No activity found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
};

export default LiveMonitoringDashboard;
