
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useAgentLiveStream } from '../hooks/useAgentLiveStream';
import { updateWorkLog, getTeamById, streamActiveWorkLog, updateAgentStatus, streamGlobalAdminSettings, performClockOut, performClockIn, isSessionStale, closeStaleSession } from '../services/db';
import { serverTimestamp, increment, Timestamp, doc, onSnapshot, deleteField } from 'firebase/firestore';
import { db } from '../services/firebase';
import type { WorkLog, Team, AdminSettingsType, ActivityEntry } from '../types';
import Spinner from './Spinner';
import ActivitySheet from './ActivitySheet';
import AgentScheduleView from './AgentScheduleView';
import TeamStatusView from './TeamStatusView';

const formatDuration = (totalSeconds: number): string => {
    if (totalSeconds < 0) totalSeconds = 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return [hours, minutes, seconds]
        .map(v => v.toString().padStart(2, '0'))
        .join(':');
};

const TabButton = ({ tabName, title, activeTab, setActiveTab }: { tabName: string, title: string, activeTab: string, setActiveTab: (tab: string) => void }) => (
    <button
        onClick={() => setActiveTab(tabName)}
        className={`px-4 py-2 text-sm font-medium rounded-md ${activeTab === tabName ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
    >
        {title}
    </button>
);

const deriveBreakCause = (entry: any): 'manual' | 'idle' => {
    const raw = (entry?.cause || entry?.reason || entry?.type || entry?.source || '').toString().toLowerCase();
    // Screen lock is a system event, not a manual break - categorize with idle/system
    if (raw.includes('idle') || raw.includes('screen_lock') || raw.includes('lock')) return 'idle';
    if (entry?.auto === true || entry?.isIdle === true || entry?.isSystemEvent === true) return 'idle';
    return 'manual';
};

const deriveBreakDurations = (log: WorkLog, nowMs: number, getMillis: (ts: any) => number) => {
    const breaks = Array.isArray((log as any)?.breaks) ? (log as any).breaks : [];
    let manualSeconds = 0;
    let idleSeconds = 0;
    let accounted = false;

    // When session is clocked out, don't add any live elapsed time
    const isClockedOut = log.status === 'clocked_out';
    // Use lastEventTimestamp as the cutoff for clocked out sessions
    const lastEventMs = log.lastEventTimestamp ? getMillis(log.lastEventTimestamp) : nowMs;
    const cutoffMs = isClockedOut ? lastEventMs : nowMs;

    breaks.forEach((entry: any) => {
        const startMs = entry?.startTime ? getMillis(entry.startTime) : null;
        if (startMs == null) return;
        const endMs = entry?.endTime ? getMillis(entry.endTime) : null;
        // For open breaks, use cutoff (lastEvent for clocked out, now for active)
        const effectiveEnd = endMs ?? cutoffMs;
        if (effectiveEnd <= startMs) return;
        accounted = true;
        const duration = (effectiveEnd - startMs) / 1000;
        if (deriveBreakCause(entry) === 'idle') idleSeconds += duration;
        else manualSeconds += duration;
    });

    if (!accounted) {
        manualSeconds = typeof log.totalBreakSeconds === 'number' ? log.totalBreakSeconds : 0;
        const isOnBreak = log.status === 'on_break' || (log.status as any) === 'break';
        // Only add live elapsed if actively on break (not clocked out)
        if (isOnBreak && !isClockedOut && lastEventMs && nowMs > lastEventMs) {
            manualSeconds += (nowMs - lastEventMs) / 1000;
        }
    }

    return { manualSeconds, idleSeconds };
};

type SerializedActivity = ActivityEntry & Record<string, any>;

const cloneActivities = (entries?: SerializedActivity[]): SerializedActivity[] => (
    Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : []
);

const closeLatestActivity = (entries: SerializedActivity[], endTime: Timestamp) => {
    if (!entries.length) return entries;
    const updated = [...entries];
    const lastIndex = updated.length - 1;
    const last = { ...updated[lastIndex] };
    if (!last.endTime) {
        last.endTime = endTime;
        updated[lastIndex] = last;
    }
    return updated;
};

const transitionActivities = (
    entries: SerializedActivity[] | undefined,
    transitionTs: Timestamp,
    nextEntry: SerializedActivity
): SerializedActivity[] => {
    const closed = closeLatestActivity(cloneActivities(entries), transitionTs);
    closed.push(nextEntry);
    return closed;
};

const AgentPanel: React.FC = () => {
    const { userData } = useAuth();
    useAgentLiveStream();
    const [workLog, setWorkLog] = useState<WorkLog | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [displayWorkSeconds, setDisplayWorkSeconds] = useState(0);
    const [displayBreakSeconds, setDisplayBreakSeconds] = useState(0);
    const [isAway, setIsAway] = useState(false); // Track screen lock "away" state
    const [activeTab, setActiveTab] = useState('timeClock');

    const [adminSettings, setAdminSettings] = useState<AdminSettingsType | null>(null);
    const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
    const [availableTeams, setAvailableTeams] = useState<Team[]>([]);


    const workLogRef = useRef<WorkLog | null>(null);
    const manualBreakRef = useRef(false);
    const idleBreakActiveRef = useRef(false);
    const isIdleRef = useRef(false); // Track remote isIdle state for timer calculation
    const lastDesktopSyncRef = useRef<'working' | 'clocked_out' | 'manual_break' | null>(null);

    const reportDesktopError = useCallback((payload: any) => {
        try {
            window.desktopAPI?.reportError?.(payload);
        } catch {
            // ignore
        }
    }, []);

    const notifyDesktopStatus = useCallback(async (status: 'working' | 'clocked_out' | 'manual_break') => {
        try {
            const desktopApi = (window as any).desktopAPI;
            if (!desktopApi?.setAgentStatus) return;
            await desktopApi.setAgentStatus(status);
        } catch (err) {
            console.error('[AgentPanel] Failed to notify desktop about status change', status, err);
            reportDesktopError({
                message: 'notify_desktop_status_failed',
                status,
                error: (err as any)?.message || String(err)
            });
        }
    }, [reportDesktopError]);
    useEffect(() => { workLogRef.current = workLog; }, [workLog]);

    useEffect(() => {
        if (loading) return;
        const status: 'working' | 'clocked_out' | 'manual_break' | null = (() => {
            if (!workLog) return 'clocked_out';
            const normalized = (workLog.status || '').toLowerCase();
            if (normalized === 'working') return 'working';
            if (normalized === 'on_break' || normalized === 'break') {
                return manualBreakRef.current ? 'manual_break' : null;
            }
            return 'clocked_out';
        })();

        if (!status || lastDesktopSyncRef.current === status) return;
        lastDesktopSyncRef.current = status;
        notifyDesktopStatus(status);
    }, [loading, workLog, notifyDesktopStatus]);

    const getMillis = useCallback((ts: any): number => {
        if (!ts) return Date.now();
        if (ts instanceof Timestamp) return ts.toDate().getTime();
        if (typeof ts.toMillis === 'function') return ts.toMillis();
        if (typeof ts.toDate === 'function') return ts.toDate().getTime();
        return Date.now();
    }, []);

    // Team Fetching
    useEffect(() => {
        const fetchAgentTeams = async () => {
            if (userData) {
                const ids = userData.teamIds || (userData.teamId ? [userData.teamId] : []);
                if (ids.length > 0) {
                    try {
                        const promises = ids.map((id: string) => getTeamById(id));
                        const results = await Promise.all(promises);
                        const validTeams = results.filter((t: Team | null) => t !== null) as Team[];
                        setAvailableTeams(validTeams);
                        if (validTeams.length > 0 && !activeTeamId) {
                            setActiveTeamId(validTeams[0].id);
                        }
                    } catch (e) { console.error(e); }
                }
            }
        };
        fetchAgentTeams();
    }, [userData]);

    // Active Log Streaming
    useEffect(() => {
        if (!userData || !activeTeamId) return;

        setLoading(true);
        const unsubscribe = streamActiveWorkLog(userData.uid, (activeLog) => {
            if (activeLog) {
                // Zombie check logic is now handled primarily in performClockIn
                // But we can still check purely for display purposes or alerts
                setWorkLog(activeLog);
            } else {
                setWorkLog(null);
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, [userData, activeTeamId]);

    // Global Settings
    useEffect(() => streamGlobalAdminSettings(setAdminSettings), []);


    // Local Timer Calculation
    useEffect(() => {
        if (!workLog) {
            setDisplayWorkSeconds(0);
            setDisplayBreakSeconds(0);
            return;
        }

        const updateDisplays = () => {
            const now = Date.now();
            const lastEventTime = workLog.lastEventTimestamp ? getMillis(workLog.lastEventTimestamp) : null;
            // Only count work time when status is 'working' AND not idle/on manual break/away
            // This ensures mutual exclusivity between work/idle/break counters
            const shouldCountWork = lastEventTime
                && workLog.status === 'working'
                && !isIdleRef.current
                && !manualBreakRef.current
                && !isAway;
            if (shouldCountWork) {
                const elapsed = Math.max(0, (now - lastEventTime) / 1000);
                setDisplayWorkSeconds(workLog.totalWorkSeconds + elapsed);
            } else {
                setDisplayWorkSeconds(workLog.totalWorkSeconds);
            }

            const { manualSeconds, idleSeconds } = deriveBreakDurations(workLog, now, getMillis);
            setDisplayBreakSeconds(manualSeconds + idleSeconds);
        };

        updateDisplays();

        let interval: number | null = null;
        if (workLog.status !== 'clocked_out' && workLog.lastEventTimestamp) {
            interval = window.setInterval(updateDisplays, 1000);
        }

        return () => { if (interval) clearInterval(interval); };
    }, [workLog, getMillis]);

    // Listen for remote status/idle changes
    useEffect(() => {
        if (!userData?.uid) return;
        const uid = userData.uid;
        const unsubscribe = onSnapshot(doc(db, "agentStatus", uid), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                manualBreakRef.current = !!data.manualBreak;
                isIdleRef.current = !!data.isIdle; // Update idle ref for timer calculation
                setIsAway(!!data.isAway); // Track screen lock away state
                if (data.manualBreak) idleBreakActiveRef.current = false;

                // Track break start
                // Handle Idle Changes Logic (Sync with Firestore)
                const currentLog = workLogRef.current;
                if (currentLog && !data.manualBreak) {
                    const getDuration = (ts: any) => (Date.now() - getMillis(ts)) / 1000;

                    const getLastBreak = () => {
                        const breaks = (currentLog as any)?.breaks;
                        if (!Array.isArray(breaks) || breaks.length === 0) return null;
                        return breaks[breaks.length - 1];
                    };

                    const lastBreak = getLastBreak();
                    const hasOpenIdleBreak = Boolean(
                        lastBreak &&
                        !lastBreak?.endTime &&
                        deriveBreakCause(lastBreak) === 'idle'
                    );

                    // Auto-Break on Idle
                    if (data.isIdle === true && currentLog.status === 'working') {
                        idleBreakActiveRef.current = true;
                        const wDur = getDuration(currentLog.lastEventTimestamp);
                        const newBreaks = [...(currentLog.breaks || [])] as any[];
                        const idleStartTs = Timestamp.now();

                        // ROBUSTNESS: Ensure any open screen_lock entry is closed locally before pushing idle break
                        // This prevents React from overwriting Electron's parallel update with stale open-lock data
                        if (newBreaks.length > 0) {
                            const lastIdx = newBreaks.length - 1;
                            const lastEntry = newBreaks[lastIdx];
                            if (lastEntry.cause === 'screen_lock' && !lastEntry.endTime) {
                                newBreaks[lastIdx] = { ...lastEntry, endTime: idleStartTs };
                            }
                        }

                        newBreaks.push({ startTime: idleStartTs, endTime: null, cause: 'idle' });
                        const activities = transitionActivities(currentLog.activities as SerializedActivity[] | undefined, idleStartTs, {
                            type: 'on_break',
                            cause: 'idle',
                            startTime: idleStartTs,
                            endTime: null
                        } as SerializedActivity);
                        updateWorkLog(currentLog.id, {
                            status: 'on_break',
                            totalWorkSeconds: increment(wDur),
                            lastEventTimestamp: serverTimestamp(),
                            breaks: newBreaks,
                            activities
                        }).catch((err: any) => {
                            console.error('[AgentPanel] failed to persist idle break', err);
                            reportDesktopError({ message: 'worklog_update_failed_idle_break', error: err?.message || String(err) });
                        });
                    }
                    // Auto-Resume
                    else if (data.isIdle === false && (idleBreakActiveRef.current || hasOpenIdleBreak)) {
                        idleBreakActiveRef.current = false;
                        // Don't auto-resume if it was a manual break (handled by manualBreak check above generally, but good to be safe)
                        const bDur = getDuration(currentLog.lastEventTimestamp);
                        const newBreaks = [...(currentLog.breaks || [])];
                        const resumeTs = Timestamp.now();
                        if (newBreaks.length > 0) {
                            newBreaks[newBreaks.length - 1].endTime = resumeTs;
                        }
                        const activities = transitionActivities(currentLog.activities as SerializedActivity[] | undefined, resumeTs, {
                            type: 'working',
                            startTime: resumeTs,
                            endTime: null
                        } as SerializedActivity);
                        updateWorkLog(currentLog.id, {
                            status: 'working',
                            totalBreakSeconds: increment(bDur),
                            lastEventTimestamp: serverTimestamp(),
                            breaks: newBreaks,
                            activities
                        }).catch((err: any) => {
                            console.error('[AgentPanel] failed to persist idle resume', err);
                            reportDesktopError({ message: 'worklog_update_failed_idle_resume', error: err?.message || String(err) });
                        });
                        updateAgentStatus(uid, 'online', {
                            manualBreak: false,
                            breakStartedAt: deleteField(),
                            isIdle: false
                        }).catch((err) => console.error('[AgentPanel] failed to sync agent status after idle resume', err));
                        notifyDesktopStatus('working').catch((err) => console.error('[AgentPanel] failed to notify desktop of idle resume', err));
                    }
                }
            }
        });
        return () => unsubscribe();
    }, [userData?.uid, getMillis, notifyDesktopStatus]);

    // Actions
    const handleClockIn = async () => {
        if (!userData || !activeTeamId) return;
        setLoading(true);
        try {
            await performClockIn(userData.uid, activeTeamId, userData.displayName || 'Agent');
            await notifyDesktopStatus('working');
        } catch (e: any) {
            setError('Clock in failed');
            console.error(e);
            reportDesktopError({ message: 'clock_in_failed', error: e?.message || String(e) });
        }
        finally { setLoading(false); }
    };

    const handleClockOut = async () => {
        if (!userData) return;
        setLoading(true);
        try {
            await performClockOut(userData.uid);
            setWorkLog(null);
            await notifyDesktopStatus('clocked_out');
        } catch (e: any) {
            setError('Clock out failed');
            reportDesktopError({ message: 'clock_out_failed', error: e?.message || String(e) });
        }
        finally { setLoading(false); }
    };

    const handleStartBreak = async () => {
        if (!workLog || !userData) return;
        setLoading(true);
        try {
            const dur = (Date.now() - getMillis(workLog.lastEventTimestamp)) / 1000;
            const newBreaks = [...(workLog.breaks || [])];
            const breakStartTs = Timestamp.now();
            newBreaks.push({ startTime: breakStartTs, endTime: null, cause: 'manual' });

            const activities = transitionActivities(workLog.activities as SerializedActivity[] | undefined, breakStartTs, {
                type: 'on_break',
                cause: 'manual',
                startTime: breakStartTs,
                endTime: null
            } as SerializedActivity);

            await updateWorkLog(workLog.id, {
                status: 'on_break',
                totalWorkSeconds: increment(dur),
                lastEventTimestamp: serverTimestamp(),
                breaks: newBreaks,
                activities
            });
            await updateAgentStatus(userData.uid, 'break', { manualBreak: true, breakStartedAt: serverTimestamp() });
            await notifyDesktopStatus('manual_break');
        } catch (e) {
            setError('Failed to start break');
            console.error(e);
            reportDesktopError({ message: 'start_break_failed', error: (e as any)?.message || String(e) });
        } finally {
            setLoading(false);
        }
    };

    const handleEndBreak = useCallback(async () => {
        if (!workLog || !userData) return;
        setLoading(true);
        try {
            const dur = (Date.now() - getMillis(workLog.lastEventTimestamp)) / 1000;
            const newBreaks = [...(workLog.breaks || [])];
            const breakEndTs = Timestamp.now();
            if (newBreaks.length > 0) newBreaks[newBreaks.length - 1].endTime = breakEndTs;

            const activities = transitionActivities(workLog.activities as SerializedActivity[] | undefined, breakEndTs, {
                type: 'working',
                startTime: breakEndTs,
                endTime: null
            } as SerializedActivity);

            await updateWorkLog(workLog.id, {
                status: 'working',
                totalBreakSeconds: increment(dur),
                lastEventTimestamp: serverTimestamp(),
                breaks: newBreaks,
                activities
            });
            await updateAgentStatus(userData.uid, 'online', { manualBreak: false, breakStartedAt: deleteField() });
            await notifyDesktopStatus('working');
        } catch (e) {
            setError('Failed to end break');
            console.error(e);
            reportDesktopError({ message: 'end_break_failed', error: (e as any)?.message || String(e) });
        } finally {
            setLoading(false);
        }
    }, [workLog, userData, getMillis, notifyDesktopStatus]);

    useEffect(() => {
        if (!window.desktopAPI?.onDesktopRequestEndBreak) return;
        const cleanup = window.desktopAPI.onDesktopRequestEndBreak(() => {
            handleEndBreak().catch((err) => console.error('[AgentPanel] desktop-request-end-break failed', err));
        });
        return () => {
            if (typeof cleanup === 'function') cleanup();
        };
    }, [handleEndBreak]);

    if (loading && !workLog) return <Spinner />;

    return (
        <div>
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200">Agent Dashboard</h2>
                {availableTeams.length > 1 && (
                    <select value={activeTeamId || ''} onChange={(e) => setActiveTeamId(e.target.value)} className="bg-gray-50 border text-sm rounded-lg p-1.5 dark:bg-gray-700 dark:text-white">
                        {availableTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
                    </select>
                )}
            </div>

            <div className="mb-6 border-b dark:border-gray-700"><nav className="flex space-x-2">
                <TabButton tabName="timeClock" title="Time Clock" activeTab={activeTab} setActiveTab={setActiveTab} />
                <TabButton tabName="mySchedule" title="My Schedule" activeTab={activeTab} setActiveTab={setActiveTab} />
                <TabButton tabName="activityLog" title="Activity Log" activeTab={activeTab} setActiveTab={setActiveTab} />
            </nav></div>

            {activeTab === 'timeClock' && (
                <div>
                    {error && <p className="text-red-500 mb-4">{error}</p>}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                        <div className="p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border text-center">
                            <p className="text-sm text-gray-500">CURRENT STATUS</p>
                            <p className={`text-2xl font-bold mt-1 uppercase ${isAway ? 'text-amber-600' : 'text-gray-900 dark:text-white'}`}>
                                {isAway ? '🔒 Away' : (workLog?.status.replace('_', ' ') || 'Clocked Out')}
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border text-center">
                                <p className="text-sm text-gray-500">Work Hours</p>
                                <p className="text-2xl font-semibold mt-1 text-gray-900 dark:text-white">{formatDuration(displayWorkSeconds)}</p>
                            </div>
                            <div className="p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border text-center">
                                <p className="text-sm text-gray-500">Break Hours</p>
                                <p className="text-2xl font-semibold mt-1 text-gray-900 dark:text-white">{formatDuration(displayBreakSeconds)}</p>
                            </div>
                        </div>
                    </div>

                    <div className="mb-6">
                        {!workLog || workLog.status === 'clocked_out' ? (
                            <button onClick={handleClockIn} disabled={loading} className="w-full text-white bg-green-600 hover:bg-green-700 font-medium rounded-lg text-sm px-5 py-2.5">Clock In</button>
                        ) : workLog.status === 'working' ? (
                            <div className="flex gap-4">
                                <button onClick={handleStartBreak} disabled={loading} className="w-full text-white bg-yellow-500 hover:bg-yellow-600 font-medium rounded-lg text-sm px-5 py-2.5">Start Break</button>
                                <button onClick={handleClockOut} disabled={loading} className="w-full text-white bg-red-600 hover:bg-red-700 font-medium rounded-lg text-sm px-5 py-2.5">Clock Out</button>
                            </div>
                        ) : (
                            <button onClick={handleEndBreak} disabled={loading} className="w-full text-white bg-blue-600 hover:bg-blue-700 font-medium rounded-lg text-sm px-5 py-2.5">End Break</button>
                        )}
                    </div>

                    {adminSettings?.showLiveTeamStatusToAgents !== false && activeTeamId && userData && (
                        <div className="my-8">
                            <TeamStatusView
                                teamId={activeTeamId}
                                currentUserId={userData.uid}
                                isMinimizable={true}
                            />
                        </div>
                    )}
                </div>
            )}
            {activeTab === 'mySchedule' && userData && activeTeamId && <AgentScheduleView userId={userData.uid} teamId={activeTeamId} />}
            {activeTab === 'activityLog' && workLog && (
                <ActivitySheet workLog={workLog} timezone={adminSettings?.organizationTimezone || undefined} />
            )}
        </div>
    );
};
export default AgentPanel;
