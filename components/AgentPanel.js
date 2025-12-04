import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useAgentLiveStream } from '../hooks/useAgentLiveStream';
import { updateWorkLog, getTeamById, streamActiveWorkLog, updateAgentStatus, streamGlobalAdminSettings, streamScheduleForMonth, updateAgentAutoClockOut, performClockOut, performClockIn } from '../services/db';
import { serverTimestamp, increment, Timestamp, doc, onSnapshot, deleteField } from 'firebase/firestore';
import { db } from '../services/firebase';
import Spinner from './Spinner';
import ActivitySheet from './ActivitySheet';
import AgentScheduleView from './AgentScheduleView';
import TeamStatusView from './TeamStatusView';
import ManualBreakTimeoutModal from './ManualBreakTimeoutModal';
const formatDuration = (totalSeconds) => {
    if (totalSeconds < 0)
        totalSeconds = 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return [hours, minutes, seconds]
        .map(v => v.toString().padStart(2, '0'))
        .join(':');
};
const TabButton = ({ tabName, title, activeTab, setActiveTab }) => (_jsx("button", { onClick: () => setActiveTab(tabName), className: `px-4 py-2 text-sm font-medium rounded-md ${activeTab === tabName ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`, children: title }));
const AgentPanel = () => {
    const { userData } = useAuth();
    useAgentLiveStream();
    const [workLog, setWorkLog] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [displayWorkSeconds, setDisplayWorkSeconds] = useState(0);
    const [displayBreakSeconds, setDisplayBreakSeconds] = useState(0);
    const [teamSettings, setTeamSettings] = useState(null);
    const [activeTab, setActiveTab] = useState('timeClock');
    const [adminSettings, setAdminSettings] = useState(null);
    const [monthlySchedule, setMonthlySchedule] = useState({});
    const [activeTeamId, setActiveTeamId] = useState(null);
    const [availableTeams, setAvailableTeams] = useState([]);
    const [showTimeoutModal, setShowTimeoutModal] = useState(false);
    const [dismissedTimeout, setDismissedTimeout] = useState(false);
    const [breakStartedAt, setBreakStartedAt] = useState(null);
    const workLogRef = useRef(null);
    const lastDesktopSyncRef = useRef(null);
    useEffect(() => { workLogRef.current = workLog; }, [workLog]);
    useEffect(() => {
        if (loading)
            return;
        const status = (() => {
            if (!workLog)
                return 'clocked_out';
            const normalized = (workLog.status || '').toLowerCase();
            if (normalized === 'working')
                return 'working';
            if (normalized === 'on_break' || normalized === 'break')
                return 'manual_break';
            return 'clocked_out';
        })();
        if (lastDesktopSyncRef.current === status)
            return;
        lastDesktopSyncRef.current = status;
        try {
            window.desktopAPI?.setAgentStatus?.(status);
        }
        catch (err) {
            console.error('[AgentPanel] Failed to sync desktop status from worklog stream', status, err);
        }
    }, [loading, workLog]);
    const getMillis = useCallback((ts) => {
        if (!ts)
            return Date.now();
        if (ts instanceof Timestamp)
            return ts.toDate().getTime();
        if (typeof ts.toMillis === 'function')
            return ts.toMillis();
        if (typeof ts.toDate === 'function')
            return ts.toDate().getTime();
        return Date.now();
    }, []);
    // Team Fetching
    useEffect(() => {
        const fetchAgentTeams = async () => {
            if (userData) {
                const ids = userData.teamIds || (userData.teamId ? [userData.teamId] : []);
                if (ids.length > 0) {
                    try {
                        const promises = ids.map((id) => getTeamById(id));
                        const results = await Promise.all(promises);
                        const validTeams = results.filter((t) => t !== null);
                        setAvailableTeams(validTeams);
                        if (validTeams.length > 0 && !activeTeamId) {
                            setActiveTeamId(validTeams[0].id);
                        }
                    }
                    catch (e) {
                        console.error(e);
                    }
                }
            }
        };
        fetchAgentTeams();
    }, [userData]);
    // Active Log Streaming
    useEffect(() => {
        if (!userData || !activeTeamId)
            return;
        setLoading(true);
        const unsubscribe = streamActiveWorkLog(userData.uid, (activeLog) => {
            if (activeLog) {
                // Zombie check logic is now handled primarily in performClockIn
                // But we can still check purely for display purposes or alerts
                setWorkLog(activeLog);
            }
            else {
                setWorkLog(null);
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, [userData, activeTeamId]);
    // Global Settings
    useEffect(() => streamGlobalAdminSettings(setAdminSettings), []);
    // Schedule Sync
    useEffect(() => {
        if (!activeTeamId)
            return;
        const today = new Date();
        return streamScheduleForMonth(activeTeamId, today.getFullYear(), today.getMonth() + 1, setMonthlySchedule);
    }, [activeTeamId]);
    // Auto Clock Out Sync
    useEffect(() => {
        if (!userData || !adminSettings)
            return;
        const syncAutoClockOut = async () => {
            const today = new Date();
            const dateString = today.toISOString().split('T')[0];
            const userSchedule = monthlySchedule[userData.uid];
            let shiftEndTime = "";
            let shouldEnable = false;
            if (adminSettings.autoClockOutEnabled && userSchedule) {
                const todayShift = userSchedule[dateString];
                if (todayShift && typeof todayShift === 'object' && 'endTime' in todayShift) {
                    shiftEndTime = todayShift.endTime;
                    shouldEnable = true;
                }
            }
            await updateAgentAutoClockOut(userData.uid, { enabled: shouldEnable, shiftEndTime });
        };
        syncAutoClockOut();
    }, [userData, adminSettings, monthlySchedule]);
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
        let interval = null;
        const isActive = workLog.status !== 'clocked_out';
        if (isActive && workLog.lastEventTimestamp) {
            interval = window.setInterval(() => {
                const lastEventTime = getMillis(workLog.lastEventTimestamp);
                const now = Date.now();
                const elapsed = Math.max(0, (now - lastEventTime) / 1000);
                if (workLog.status === 'working') {
                    setDisplayWorkSeconds(workLog.totalWorkSeconds + elapsed);
                }
                else if (workLog.status === 'on_break' || workLog.status === 'break') {
                    setDisplayBreakSeconds(workLog.totalBreakSeconds + elapsed);
                }
            }, 1000);
        }
        return () => { if (interval)
            clearInterval(interval); };
    }, [workLog, getMillis]);
    // Listen for remote status/idle changes
    useEffect(() => {
        if (!userData?.uid)
            return;
        const unsubscribe = onSnapshot(doc(db, "agentStatus", userData.uid), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                // Track break start
                if (data.manualBreak && data.breakStartedAt) {
                    setBreakStartedAt(getMillis(data.breakStartedAt));
                }
                else {
                    setBreakStartedAt(null);
                    setDismissedTimeout(false);
                }
                // Handle Idle Changes Logic (Sync with Firestore)
                const currentLog = workLogRef.current;
                if (currentLog && !data.manualBreak) {
                    const getDuration = (ts) => (Date.now() - getMillis(ts)) / 1000;
                    // Auto-Break on Idle
                    if (data.isIdle === true && currentLog.status === 'working') {
                        const wDur = getDuration(currentLog.lastEventTimestamp);
                        const newBreaks = [...(currentLog.breaks || [])];
                        newBreaks.push({ startTime: Timestamp.now(), endTime: null });
                        updateWorkLog(currentLog.id, {
                            status: 'on_break',
                            totalWorkSeconds: increment(wDur),
                            lastEventTimestamp: serverTimestamp(),
                            breaks: newBreaks,
                        });
                    }
                    // Auto-Resume
                    else if (data.isIdle === false && (currentLog.status === 'on_break' || currentLog.status === 'break')) {
                        // Don't auto-resume if it was a manual break (handled by manualBreak check above generally, but good to be safe)
                        const bDur = getDuration(currentLog.lastEventTimestamp);
                        const newBreaks = [...(currentLog.breaks || [])];
                        if (newBreaks.length > 0) {
                            newBreaks[newBreaks.length - 1].endTime = Timestamp.now();
                        }
                        updateWorkLog(currentLog.id, {
                            status: 'working',
                            totalBreakSeconds: increment(bDur),
                            lastEventTimestamp: serverTimestamp(),
                            breaks: newBreaks,
                        });
                    }
                }
            }
        });
        return () => unsubscribe();
    }, [userData?.uid, getMillis]);
    // Manual Break Timeout
    useEffect(() => {
        if (!breakStartedAt || !adminSettings?.manualBreakTimeoutMinutes || dismissedTimeout) {
            setShowTimeoutModal(false);
            return;
        }
        const check = () => {
            const elapsed = (Date.now() - breakStartedAt) / 60000;
            const timeout = adminSettings.manualBreakTimeoutMinutes ?? 30;
            if (elapsed >= timeout)
                setShowTimeoutModal(true);
        };
        check();
        const i = setInterval(check, 10000);
        return () => clearInterval(i);
    }, [breakStartedAt, adminSettings, dismissedTimeout]);
    // Actions
    const handleClockIn = async () => {
        if (!userData || !activeTeamId)
            return;
        setLoading(true);
        try {
            await performClockIn(userData.uid, activeTeamId, userData.displayName || 'Agent');
            if (window.desktopAPI?.setAgentStatus)
                window.desktopAPI.setAgentStatus("working");
        }
        catch (e) {
            setError('Clock in failed');
            console.error(e);
        }
        finally {
            setLoading(false);
        }
    };
    const handleClockOut = async () => {
        if (!userData)
            return;
        setLoading(true);
        try {
            await performClockOut(userData.uid);
            setWorkLog(null);
            if (window.desktopAPI?.setAgentStatus)
                window.desktopAPI.setAgentStatus("clocked_out");
        }
        catch (e) {
            setError('Clock out failed');
        }
        finally {
            setLoading(false);
        }
    };
    const handleStartBreak = async () => {
        if (!workLog || !userData)
            return;
        setLoading(true);
        const dur = (Date.now() - getMillis(workLog.lastEventTimestamp)) / 1000;
        const newBreaks = [...(workLog.breaks || [])];
        newBreaks.push({ startTime: Timestamp.now(), endTime: null });
        await updateWorkLog(workLog.id, {
            status: 'on_break',
            totalWorkSeconds: increment(dur),
            lastEventTimestamp: serverTimestamp(),
            breaks: newBreaks
        });
        await updateAgentStatus(userData.uid, 'break', { manualBreak: true, breakStartedAt: serverTimestamp() });
        setLoading(false);
    };
    const handleEndBreak = async () => {
        if (!workLog || !userData)
            return;
        setLoading(true);
        setShowTimeoutModal(false);
        const dur = (Date.now() - getMillis(workLog.lastEventTimestamp)) / 1000;
        const newBreaks = [...(workLog.breaks || [])];
        if (newBreaks.length > 0)
            newBreaks[newBreaks.length - 1].endTime = Timestamp.now();
        await updateWorkLog(workLog.id, {
            status: 'working',
            totalBreakSeconds: increment(dur),
            lastEventTimestamp: serverTimestamp(),
            breaks: newBreaks
        });
        await updateAgentStatus(userData.uid, 'online', { manualBreak: false, breakStartedAt: deleteField() });
        setLoading(false);
    };
    if (loading && !workLog)
        return _jsx(Spinner, {});
    return (_jsxs("div", { children: [_jsx(ManualBreakTimeoutModal, { isOpen: showTimeoutModal, timeoutMinutes: adminSettings?.manualBreakTimeoutMinutes || 30, onRemoveBreak: handleEndBreak, onContinueBreak: () => { setShowTimeoutModal(false); setDismissedTimeout(true); } }), _jsxs("div", { className: "flex justify-between items-center mb-4", children: [_jsx("h2", { className: "text-2xl font-semibold text-gray-800 dark:text-gray-200", children: "Agent Dashboard" }), availableTeams.length > 1 && (_jsx("select", { value: activeTeamId || '', onChange: (e) => setActiveTeamId(e.target.value), className: "bg-gray-50 border text-sm rounded-lg p-1.5 dark:bg-gray-700 dark:text-white", children: availableTeams.map(team => _jsx("option", { value: team.id, children: team.name }, team.id)) }))] }), _jsx("div", { className: "mb-6 border-b dark:border-gray-700", children: _jsxs("nav", { className: "flex space-x-2", children: [_jsx(TabButton, { tabName: "timeClock", title: "Time Clock", activeTab: activeTab, setActiveTab: setActiveTab }), _jsx(TabButton, { tabName: "mySchedule", title: "My Schedule", activeTab: activeTab, setActiveTab: setActiveTab }), _jsx(TabButton, { tabName: "activityLog", title: "Activity Log", activeTab: activeTab, setActiveTab: setActiveTab })] }) }), activeTab === 'timeClock' && (_jsxs("div", { children: [error && _jsx("p", { className: "text-red-500 mb-4", children: error }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4 mb-6", children: [_jsxs("div", { className: "p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border text-center", children: [_jsx("p", { className: "text-sm text-gray-500", children: "CURRENT STATUS" }), _jsx("p", { className: "text-2xl font-bold mt-1 uppercase text-gray-900 dark:text-white", children: workLog?.status.replace('_', ' ') || 'Clocked Out' })] }), _jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsxs("div", { className: "p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border text-center", children: [_jsx("p", { className: "text-sm text-gray-500", children: "Work Hours" }), _jsx("p", { className: "text-2xl font-semibold mt-1 text-gray-900 dark:text-white", children: formatDuration(displayWorkSeconds) })] }), _jsxs("div", { className: "p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border text-center", children: [_jsx("p", { className: "text-sm text-gray-500", children: "Break Hours" }), _jsx("p", { className: "text-2xl font-semibold mt-1 text-gray-900 dark:text-white", children: formatDuration(displayBreakSeconds) })] })] })] }), _jsx("div", { className: "mb-6", children: !workLog || workLog.status === 'clocked_out' ? (_jsx("button", { onClick: handleClockIn, disabled: loading, className: "w-full text-white bg-green-600 hover:bg-green-700 font-medium rounded-lg text-sm px-5 py-2.5", children: "Clock In" })) : workLog.status === 'working' ? (_jsxs("div", { className: "flex gap-4", children: [_jsx("button", { onClick: handleStartBreak, disabled: loading, className: "w-full text-white bg-yellow-500 hover:bg-yellow-600 font-medium rounded-lg text-sm px-5 py-2.5", children: "Start Break" }), _jsx("button", { onClick: handleClockOut, disabled: loading, className: "w-full text-white bg-red-600 hover:bg-red-700 font-medium rounded-lg text-sm px-5 py-2.5", children: "Clock Out" })] })) : (_jsx("button", { onClick: handleEndBreak, disabled: loading, className: "w-full text-white bg-blue-600 hover:bg-blue-700 font-medium rounded-lg text-sm px-5 py-2.5", children: "End Break" })) }), teamSettings?.showLiveTeamStatus && activeTeamId && userData && _jsx("div", { className: "my-8", children: _jsx(TeamStatusView, { teamId: activeTeamId, currentUserId: userData.uid, isMinimizable: true }) })] })), activeTab === 'mySchedule' && userData && activeTeamId && _jsx(AgentScheduleView, { userId: userData.uid, teamId: activeTeamId }), activeTab === 'activityLog' && workLog && _jsx(ActivitySheet, { workLog: workLog })] }));
};
export default AgentPanel;
