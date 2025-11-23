import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useMemo } from 'react';
import { streamTodayWorkLogs, streamAllAgentStatuses, streamGlobalAdminSettings, sendCommandToDesktop } from '../services/db';
import Spinner from './Spinner';
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
const getStatusIndicator = (status) => {
    switch (status) {
        case 'working':
            return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200", children: "Working" });
        case 'on_break':
            return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200", children: "On Break" });
        case 'clocked_out':
            return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200", children: "Offline" });
        default:
            return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200", children: "Unknown" });
    }
};
const TeamStatusView = ({ teamId, currentUserId, isMinimizable = false, canControlRecording = false }) => {
    const [isMinimized, setIsMinimized] = useState(false);
    const [workLogs, setWorkLogs] = useState([]);
    const [agentStatuses, setAgentStatuses] = useState({});
    const [adminSettings, setAdminSettings] = useState(null);
    const [loading, setLoading] = useState(true);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        setLoading(true);
        // Stream work logs (who is working today)
        const unsubscribeWorkLogs = streamTodayWorkLogs((logs) => {
            setWorkLogs(logs);
            setLoading(false); // Basic data is ready
        }, teamId);
        // Stream live agent status (connection status, recording status)
        const unsubscribeAgentStatuses = streamAllAgentStatuses((statuses) => {
            setAgentStatuses(statuses);
        });
        // Stream settings to check recording mode
        const unsubscribeSettings = streamGlobalAdminSettings((settings) => {
            setAdminSettings(settings);
        });
        return () => {
            unsubscribeWorkLogs();
            unsubscribeAgentStatuses();
            unsubscribeSettings();
        };
    }, [teamId]);
    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, []);
    const handleStartRecording = async (uid) => {
        await sendCommandToDesktop(uid, 'startRecording');
    };
    const handleStopRecording = async (uid) => {
        await sendCommandToDesktop(uid, 'stopRecording');
    };
    // Deduplicate logs by userId to ensure one row per agent in this status view
    const uniqueAgentLogs = useMemo(() => {
        const agentMap = new Map();
        workLogs.forEach(log => {
            const existing = agentMap.get(log.userId);
            if (!existing) {
                agentMap.set(log.userId, log);
                return;
            }
            // Logic: Prioritize 'Working'/'On Break' over 'Clocked Out'
            // If both are active or both inactive, pick the one with the later start time
            const isNewActive = log.status === 'working' || log.status === 'on_break' || log.status === 'break';
            const isExistingActive = existing.status === 'working' || existing.status === 'on_break' || existing.status === 'break';
            if (isNewActive && !isExistingActive) {
                agentMap.set(log.userId, log);
            }
            else if (isNewActive === isExistingActive) {
                // Tie-breaker: latest start time
                const newTime = log.startTime ? log.startTime.toMillis?.() || 0 : 0;
                const existingTime = existing.startTime ? existing.startTime.toMillis?.() || 0 : 0;
                if (newTime > existingTime) {
                    agentMap.set(log.userId, log);
                }
            }
        });
        return Array.from(agentMap.values());
    }, [workLogs]);
    const workingCount = uniqueAgentLogs.filter(log => log.status === 'working').length;
    const onBreakCount = uniqueAgentLogs.filter(log => log.status === 'on_break' || log.status === 'break').length;
    // Sort logs to show the current user on top, then alphabetical
    const displayLogs = [...uniqueAgentLogs].sort((a, b) => {
        if (a.userId === currentUserId)
            return -1;
        if (b.userId === currentUserId)
            return 1;
        return a.userDisplayName.localeCompare(b.userDisplayName);
    });
    const showRecordingControls = canControlRecording && adminSettings?.recordingMode === 'manual';
    return (_jsxs("div", { className: "mb-8 bg-white dark:bg-gray-800/50 shadow-md rounded-xl border dark:border-gray-700", children: [_jsxs("div", { className: `px-6 py-4 flex justify-between items-center ${isMinimizable ? 'cursor-pointer' : ''}`, onClick: () => isMinimizable && setIsMinimized(!isMinimized), "aria-expanded": !isMinimized, children: [_jsx("h3", { className: "text-lg font-semibold text-gray-800 dark:text-gray-200", children: "Live Team Status" }), isMinimizable && (_jsx("button", { onClick: (e) => { e.stopPropagation(); setIsMinimized(!isMinimized); }, className: "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-800", "aria-label": isMinimized ? 'Expand team status' : 'Collapse team status', children: isMinimized ? _jsx("i", { className: "fa-solid fa-chevron-down" }) : _jsx("i", { className: "fa-solid fa-chevron-up" }) }))] }), !isMinimized && (_jsx("div", { className: "p-6 border-t dark:border-gray-700", children: loading ? (_jsx("div", { className: "flex justify-center items-center p-8", children: _jsx(Spinner, {}) })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6", children: [_jsxs("div", { className: "p-6 bg-green-50 dark:bg-green-900/40 rounded-xl shadow-sm", children: [_jsx("p", { className: "text-base font-medium text-gray-700 dark:text-green-200", children: "Agents Working" }), _jsx("p", { className: "text-5xl font-bold text-gray-800 dark:text-white mt-2", children: workingCount })] }), _jsxs("div", { className: "p-6 bg-yellow-50 dark:bg-yellow-900/40 rounded-xl shadow-sm", children: [_jsx("p", { className: "text-base font-medium text-gray-700 dark:text-yellow-200", children: "Agents on Break" }), _jsx("p", { className: "text-5xl font-bold text-gray-800 dark:text-white mt-2", children: onBreakCount })] })] }), _jsxs("div", { className: "rounded-xl overflow-hidden border dark:border-gray-700", children: [_jsx("div", { className: "px-6 py-4 bg-gray-50 dark:bg-gray-700/50 border-b dark:border-gray-700", children: _jsxs("div", { className: "flex justify-between items-center text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider", children: [_jsx("span", { children: "Team Member" }), _jsxs("div", { className: "flex items-center gap-4", children: [showRecordingControls && _jsx("span", { className: "w-32 text-center", children: "Controls" }), _jsx("span", { className: "w-32 text-right", children: "Status / Duration" })] })] }) }), _jsx("div", { className: "divide-y divide-gray-200 dark:divide-gray-700", children: (displayLogs.length > 0) ? displayLogs.map(log => {
                                        const duration = (log.status === 'working' || log.status === 'on_break' || log.status === 'break') && log.lastEventTimestamp
                                            ? formatDuration(Math.max(0, Math.floor((now - log.lastEventTimestamp.toDate().getTime()) / 1000)))
                                            : null;
                                        const agentStatus = agentStatuses[log.userId];
                                        const isConnected = agentStatus?.isDesktopConnected === true;
                                        const isRecording = agentStatus?.isRecording === true;
                                        return (_jsxs("div", { className: `px-6 py-4 flex justify-between items-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-150 ${log.userId === currentUserId ? 'bg-blue-50 dark:bg-blue-900/40' : ''}`, children: [_jsxs("div", { className: "flex flex-col", children: [_jsxs("span", { className: "font-medium text-gray-900 dark:text-white", children: [log.userDisplayName, log.userId === currentUserId && _jsx("span", { className: "text-xs text-gray-500 dark:text-gray-400 ml-2", children: "(You)" })] }), _jsx("div", { className: "mt-1", children: _jsx("span", { className: "text-xs text-gray-500 dark:text-gray-400", children: isConnected ? 'Desktop' : 'Web' }) })] }), _jsxs("div", { className: "flex items-center gap-4", children: [showRecordingControls && (_jsxs("div", { className: "flex items-center gap-2 w-32 justify-center", children: [_jsx("button", { onClick: () => handleStartRecording(log.userId), disabled: !isConnected || isRecording, className: "p-1.5 bg-blue-100 text-blue-600 rounded hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-900", title: "Start Recording", children: _jsx("i", { className: "fa-solid fa-video" }) }), _jsx("button", { onClick: () => handleStopRecording(log.userId), disabled: !isConnected || !isRecording, className: "p-1.5 bg-red-100 text-red-600 rounded hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900", title: "Stop Recording", children: _jsx("i", { className: "fa-solid fa-stop" }) })] })), _jsxs("div", { className: "flex items-center gap-4 w-32 justify-end", children: [getStatusIndicator(log.status), _jsx("span", { className: "font-mono text-sm text-gray-500 dark:text-gray-400 w-16 text-right", children: duration || '--:--' })] })] })] }, log.id));
                                    }) : (_jsx("div", { className: "px-6 py-4 text-center text-gray-500 dark:text-gray-400", children: "No agent activity recorded for today." })) })] })] })) }))] }));
};
export default TeamStatusView;
