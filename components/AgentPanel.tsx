
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useAgentLiveStream } from '../hooks/useAgentLiveStream';
import { updateWorkLog, getTeamById, streamActiveWorkLog, updateAgentStatus, streamGlobalAdminSettings, performClockOut, performClockIn, isSessionStale, closeStaleSession } from '../services/db';
import { serverTimestamp, increment, Timestamp, doc, onSnapshot, deleteField } from 'firebase/firestore';
import { db } from '../services/firebase';
import type { WorkLog, Team, TeamSettings, AdminSettingsType } from '../types';
import Spinner from './Spinner';
import ActivitySheet from './ActivitySheet';
import AgentScheduleView from './AgentScheduleView';
import TeamStatusView from './TeamStatusView';
import ManualBreakTimeoutModal from './ManualBreakTimeoutModal';

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

const AgentPanel: React.FC = () => {
    const { userData } = useAuth();
    useAgentLiveStream();
    const [workLog, setWorkLog] = useState<WorkLog | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [displayWorkSeconds, setDisplayWorkSeconds] = useState(0);
    const [displayBreakSeconds, setDisplayBreakSeconds] = useState(0);
    const [teamSettings, setTeamSettings] = useState<TeamSettings | null>(null);
    const [activeTab, setActiveTab] = useState('timeClock');

    const [adminSettings, setAdminSettings] = useState<AdminSettingsType | null>(null);
    const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
    const [availableTeams, setAvailableTeams] = useState<Team[]>([]);

    const [showTimeoutModal, setShowTimeoutModal] = useState(false);
    const [dismissedTimeout, setDismissedTimeout] = useState(false);
    const [breakStartedAt, setBreakStartedAt] = useState<number | null>(null);

    const workLogRef = useRef<WorkLog | null>(null);
    const manualBreakRef = useRef(false);
    const idleBreakActiveRef = useRef(false);
    const lastDesktopSyncRef = useRef<'working' | 'clocked_out' | 'manual_break' | null>(null);
    const notifyDesktopStatus = useCallback(async (status: 'working' | 'clocked_out' | 'manual_break') => {
        try {
            const desktopApi = (window as any).desktopAPI;
            if (!desktopApi?.setAgentStatus) return;
            await desktopApi.setAgentStatus(status);
        } catch (err) {
            console.error('[AgentPanel] Failed to notify desktop about status change', status, err);
        }
    }, []);
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

        // Initialize with stored totals
        setDisplayWorkSeconds(workLog.totalWorkSeconds);
        setDisplayBreakSeconds(workLog.totalBreakSeconds);

        // If active, add the elapsed time since last event
        let interval: number | null = null;
        const isActive = workLog.status !== 'clocked_out';

        if (isActive && workLog.lastEventTimestamp) {
            interval = window.setInterval(() => {
                const lastEventTime = getMillis(workLog.lastEventTimestamp);
                const now = Date.now();
                const elapsed = Math.max(0, (now - lastEventTime) / 1000);
                
                if (workLog.status === 'working') {
                    setDisplayWorkSeconds(workLog.totalWorkSeconds + elapsed);
                } else if (workLog.status === 'on_break' || (workLog.status as any) === 'break') {
                    setDisplayBreakSeconds(workLog.totalBreakSeconds + elapsed);
                }
            }, 1000);
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
                if (data.manualBreak) idleBreakActiveRef.current = false;
                
                // Track break start
                if (data.manualBreak && data.breakStartedAt) {
                    setBreakStartedAt(getMillis(data.breakStartedAt));
                } else {
                    setBreakStartedAt(null);
                    setDismissedTimeout(false);
                }

                // Handle Idle Changes Logic (Sync with Firestore)
                const currentLog = workLogRef.current;
                if (currentLog && !data.manualBreak) {
                    const getDuration = (ts: any) => (Date.now() - getMillis(ts)) / 1000;

                    // Auto-Break on Idle
                    if (data.isIdle === true && currentLog.status === 'working') {
                        idleBreakActiveRef.current = true;
                        const wDur = getDuration(currentLog.lastEventTimestamp);
                        const newBreaks = [...(currentLog.breaks || [])];
                        newBreaks.push({ startTime: Timestamp.now(), endTime: null, cause: 'idle' });
                        updateWorkLog(currentLog.id, {
                            status: 'on_break',
                            totalWorkSeconds: increment(wDur),
                            lastEventTimestamp: serverTimestamp(),
                            breaks: newBreaks,
                        });
                    }
                    // Auto-Resume
                    else if (data.isIdle === false && (idleBreakActiveRef.current || currentLog.status === 'on_break' || (currentLog.status as any) === 'break')) {
                        idleBreakActiveRef.current = false;
                        // Don't auto-resume if it was a manual break (handled by manualBreak check above generally, but good to be safe)
                        const bDur = getDuration(currentLog.lastEventTimestamp);
                        const newBreaks = [...(currentLog.breaks || [])];
                        if(newBreaks.length > 0) {
                             newBreaks[newBreaks.length - 1].endTime = Timestamp.now();
                        }
                        updateWorkLog(currentLog.id, {
                            status: 'working',
                            totalBreakSeconds: increment(bDur),
                            lastEventTimestamp: serverTimestamp(),
                            breaks: newBreaks,
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

    // Manual Break Timeout
    useEffect(() => {
        if (!breakStartedAt || !adminSettings?.manualBreakTimeoutMinutes || dismissedTimeout) {
            setShowTimeoutModal(false);
            return;
        }
        const check = () => {
            const elapsed = (Date.now() - breakStartedAt) / 60000;
            const timeout = adminSettings.manualBreakTimeoutMinutes ?? 30;
            if (elapsed >= timeout) setShowTimeoutModal(true);
        };
        check();
        const i = setInterval(check, 10000);
        return () => clearInterval(i);
    }, [breakStartedAt, adminSettings, dismissedTimeout]);

    // Actions
    const handleClockIn = async () => {
        if (!userData || !activeTeamId) return;
        setLoading(true);
        try {
            await performClockIn(userData.uid, activeTeamId, userData.displayName || 'Agent');
            await notifyDesktopStatus('working');
        } catch (e) { setError('Clock in failed'); console.error(e); }
        finally { setLoading(false); }
    };

    const handleClockOut = async () => {
        if (!userData) return;
        setLoading(true);
        try {
            await performClockOut(userData.uid);
            setWorkLog(null);
            await notifyDesktopStatus('clocked_out');
        } catch (e) { setError('Clock out failed'); }
        finally { setLoading(false); }
    };

    const handleStartBreak = async () => {
        if (!workLog || !userData) return;
        setLoading(true);
        try {
            const dur = (Date.now() - getMillis(workLog.lastEventTimestamp)) / 1000;
            const newBreaks = [...(workLog.breaks || [])];
            newBreaks.push({ startTime: Timestamp.now(), endTime: null, cause: 'manual' });

            await updateWorkLog(workLog.id, {
                status: 'on_break',
                totalWorkSeconds: increment(dur),
                lastEventTimestamp: serverTimestamp(),
                breaks: newBreaks
            });
            await updateAgentStatus(userData.uid, 'break', { manualBreak: true, breakStartedAt: serverTimestamp() });
            await notifyDesktopStatus('manual_break');
        } catch (e) {
            setError('Failed to start break');
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleEndBreak = async () => {
        if (!workLog || !userData) return;
        setLoading(true);
        setShowTimeoutModal(false);
        try {
            const dur = (Date.now() - getMillis(workLog.lastEventTimestamp)) / 1000;
            const newBreaks = [...(workLog.breaks || [])];
            if(newBreaks.length > 0) newBreaks[newBreaks.length - 1].endTime = Timestamp.now();

            await updateWorkLog(workLog.id, {
                status: 'working',
                totalBreakSeconds: increment(dur),
                lastEventTimestamp: serverTimestamp(),
                breaks: newBreaks
            });
            await updateAgentStatus(userData.uid, 'online', { manualBreak: false, breakStartedAt: deleteField() });
            await notifyDesktopStatus('working');
        } catch (e) {
            setError('Failed to end break');
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    if (loading && !workLog) return <Spinner />;

    return (
        <div>
            <ManualBreakTimeoutModal isOpen={showTimeoutModal} timeoutMinutes={adminSettings?.manualBreakTimeoutMinutes || 30} onRemoveBreak={handleEndBreak} onContinueBreak={() => { setShowTimeoutModal(false); setDismissedTimeout(true); }} />
            
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
                            <p className="text-2xl font-bold mt-1 uppercase text-gray-900 dark:text-white">{workLog?.status.replace('_', ' ') || 'Clocked Out'}</p>
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

                    {teamSettings?.showLiveTeamStatus && activeTeamId && userData && <div className="my-8"><TeamStatusView teamId={activeTeamId} currentUserId={userData.uid} isMinimizable={true} /></div>}
                </div>
            )}
            {activeTab === 'mySchedule' && userData && activeTeamId && <AgentScheduleView userId={userData.uid} teamId={activeTeamId} />}
            {activeTab === 'activityLog' && workLog && <ActivitySheet workLog={workLog} />}
        </div>
    );
};
export default AgentPanel;
