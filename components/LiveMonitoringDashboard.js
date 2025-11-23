import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useMemo } from 'react';
import { Timestamp } from 'firebase/firestore';
import { streamTodayWorkLogs, streamWorkLogsForDate, isSessionStale, closeStaleSession, updateWorkLog } from '../services/db';
import { useAuth } from '../hooks/useAuth';
import Spinner from './Spinner';
import ActivitySheet from './ActivitySheet';
import LiveStreamModal from './LiveStreamModal';
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
const formatDateTime = (timestamp) => {
    if (!timestamp)
        return 'N/A';
    return timestamp.toDate().toLocaleString([], {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};
// Helper for datetime-local input
const toDatetimeLocal = (timestamp) => {
    if (!timestamp)
        return '';
    const d = timestamp.toDate();
    const pad = (n) => n.toString().padStart(2, '0');
    // Includes seconds for precision editing
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const ViewLogModal = ({ log, onClose }) => {
    return (_jsx("div", { className: "fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4", "aria-modal": "true", role: "dialog", children: _jsxs("div", { className: "bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col", children: [_jsxs("div", { className: "flex justify-between items-center mb-4 pb-4 border-b dark:border-gray-700", children: [_jsxs("h3", { className: "text-lg font-bold text-gray-900 dark:text-white", children: ["Activity Log: ", log.userDisplayName] }), _jsx("button", { onClick: onClose, className: "text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-2xl leading-none", children: "\u00D7" })] }), _jsx("div", { className: "overflow-y-auto", children: _jsx(ActivitySheet, { workLog: log }) })] }) }));
};
const EditTimeModal = ({ log, onClose }) => {
    const [startTime, setStartTime] = useState(toDatetimeLocal(log.clockInTime));
    const [endTime, setEndTime] = useState(toDatetimeLocal(log.clockOutTime));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const handleSave = async () => {
        if (!startTime) {
            setError("Clock In time is required.");
            return;
        }
        const startDate = new Date(startTime);
        const endDate = endTime ? new Date(endTime) : null;
        if (endDate && endDate < startDate) {
            setError("Clock Out time cannot be before Clock In time.");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const updates = {
                clockInTime: Timestamp.fromDate(startDate),
                clockOutTime: endDate ? Timestamp.fromDate(endDate) : null,
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
            // If we are setting an end time, ensure status is clocked_out
            if (endDate) {
                updates.status = 'clocked_out';
            }
            else if (log.status === 'clocked_out' && !endDate) {
                // If we are clearing the end time, set back to working
                updates.status = 'working';
            }
            await updateWorkLog(log.id, updates);
            onClose();
        }
        catch (e) {
            console.error(e);
            setError("Failed to update time logs.");
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsx("div", { className: "fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4", "aria-modal": "true", role: "dialog", children: _jsxs("div", { className: "bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl w-full max-w-md border dark:border-gray-700", children: [_jsx("h3", { className: "text-lg font-bold text-gray-900 dark:text-white mb-4", children: "Edit Time Log" }), error && _jsx("p", { className: "text-red-500 text-sm mb-4", children: error }), _jsxs("div", { className: "mb-4", children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1", children: "Clock In Time" }), _jsx("input", { type: "datetime-local", value: startTime, onChange: (e) => setStartTime(e.target.value), step: "1", className: "w-full p-2 border rounded bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-white" })] }), _jsxs("div", { className: "mb-6", children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1", children: "Clock Out Time" }), _jsx("input", { type: "datetime-local", value: endTime, onChange: (e) => setEndTime(e.target.value), step: "1", className: "w-full p-2 border rounded bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-white" }), _jsx("p", { className: "text-xs text-gray-500 dark:text-gray-400 mt-1", children: "Leave empty to keep session active." })] }), _jsxs("div", { className: "flex justify-end gap-3", children: [_jsx("button", { onClick: onClose, disabled: saving, className: "px-4 py-2 text-gray-700 bg-gray-200 rounded hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600", children: "Cancel" }), _jsx("button", { onClick: handleSave, disabled: saving, className: "px-4 py-2 text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50", children: saving ? 'Saving...' : 'Save Changes' })] })] }) }));
};
const LiveMonitoringDashboard = ({ teamId }) => {
    const { userData } = useAuth();
    const [rawLogs, setRawLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedLog, setSelectedLog] = useState(null);
    const [editingLog, setEditingLog] = useState(null);
    const [liveStreamAgent, setLiveStreamAgent] = useState(null);
    const [isLiveModalOpen, setIsLiveModalOpen] = useState(false);
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
        if (isToday) {
            // Queries for: Today's logs + ANY active logs (including yesterday's)
            unsubscribe = streamTodayWorkLogs((logs) => {
                setRawLogs(logs);
                setLoading(false);
            }, teamId);
        }
        else {
            // Historical view: strict date query
            unsubscribe = streamWorkLogsForDate(selectedDate, (logs) => {
                setRawLogs(logs);
                setLoading(false);
            }, teamId);
        }
        return () => {
            if (unsubscribe)
                unsubscribe();
        };
    }, [teamId, selectedDate, isToday]);
    // Calculate live values
    const agents = useMemo(() => {
        return rawLogs.map(log => {
            const isActive = log.status !== 'clocked_out';
            const isZombie = isSessionStale(log) && isActive;
            let totalWork = log.totalWorkSeconds;
            let totalBreak = log.totalBreakSeconds;
            // If currently active (and not stale), add live elapsed time
            if (isActive && !isZombie && log.lastEventTimestamp) {
                const lastTime = log.lastEventTimestamp.toMillis
                    ? log.lastEventTimestamp.toMillis()
                    : log.lastEventTimestamp.toDate().getTime();
                const elapsed = Math.max(0, (now - lastTime) / 1000);
                if (log.status === 'working')
                    totalWork += elapsed;
                else if (log.status === 'on_break' || log.status === 'break')
                    totalBreak += elapsed;
            }
            // Check if this log started on a previous day
            let isOvernight = false;
            if (log.date) {
                const logDate = log.date.toDate();
                const selected = new Date(selectedDate);
                // Basic check: if log date is before selected viewing date (which is usually today)
                if (logDate.setHours(0, 0, 0, 0) < selected.setHours(0, 0, 0, 0)) {
                    isOvernight = true;
                }
            }
            return {
                ...log,
                displayWork: totalWork,
                displayBreak: totalBreak,
                isZombie,
                isOvernight
            };
        });
    }, [rawLogs, now, selectedDate]);
    const handleForceClose = async (log) => {
        if (window.confirm("Force close this session? This marks it as clocked out at the last active time.")) {
            await closeStaleSession(log);
        }
    };
    const managerTeamIds = useMemo(() => {
        if (!userData)
            return [];
        if (Array.isArray(userData.teamIds) && userData.teamIds.length > 0)
            return userData.teamIds;
        return userData.teamId ? [userData.teamId] : [];
    }, [userData]);
    const canRequestStreamForAgent = (log) => {
        if (!log || log.status === 'clocked_out' || !userData)
            return false;
        if (userData.role === 'admin')
            return true;
        if (userData.role === 'manager' && log.teamId) {
            return managerTeamIds.includes(log.teamId);
        }
        return false;
    };
    const handleLiveStream = (log) => {
        if (!log?.userId || !canRequestStreamForAgent(log))
            return;
        setLiveStreamAgent({ uid: log.userId, displayName: log.userDisplayName, teamId: log.teamId });
        setIsLiveModalOpen(true);
    };
    const closeLiveStreamModal = () => {
        setIsLiveModalOpen(false);
        setLiveStreamAgent(null);
    };
    const getStatusBadge = (agent) => {
        if (agent.isZombie) {
            return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 animate-pulse", children: "Stale / Zombie" });
        }
        switch (agent.status) {
            case 'working':
                return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200", children: "Working" });
            case 'on_break':
            case 'break':
                return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200", children: "On Break" });
            case 'clocked_out':
                return _jsx("span", { className: "px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200", children: "Offline" });
            default:
                return null;
        }
    };
    if (loading && !rawLogs.length)
        return _jsx("div", { className: "p-8 flex justify-center", children: _jsx(Spinner, {}) });
    return (_jsxs(_Fragment, { children: [isLiveModalOpen && liveStreamAgent && (_jsx(LiveStreamModal, { isOpen: isLiveModalOpen, agent: liveStreamAgent, onClose: closeLiveStreamModal })), selectedLog && _jsx(ViewLogModal, { log: selectedLog, onClose: () => setSelectedLog(null) }), editingLog && _jsx(EditTimeModal, { log: editingLog, onClose: () => setEditingLog(null) }), _jsxs("div", { className: "mb-4 flex flex-col sm:flex-row justify-between items-center gap-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border dark:border-gray-700", children: [_jsx("h3", { className: "text-lg font-medium text-gray-900 dark:text-white", children: "Monitoring" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("label", { htmlFor: "monitor-date", className: "text-sm font-medium text-gray-700 dark:text-gray-300", children: "Date:" }), _jsx("input", { type: "date", id: "monitor-date", value: selectedDate, onChange: (e) => setSelectedDate(e.target.value), className: "bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white" })] })] }), _jsx("div", { className: "overflow-x-auto relative shadow-md sm:rounded-lg", children: _jsxs("table", { className: "w-full text-sm text-left text-gray-500 dark:text-gray-400", children: [_jsx("thead", { className: "text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400", children: _jsxs("tr", { children: [_jsx("th", { scope: "col", className: "py-3 px-6", children: "Agent" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Status" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Shift Info" }), _jsx("th", { scope: "col", className: "py-3 px-6 text-center", children: "Clock In" }), _jsx("th", { scope: "col", className: "py-3 px-6 text-center", children: "Clock Out" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Work Duration" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Break Duration" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Actions" })] }) }), _jsx("tbody", { children: agents.length > 0 ? agents.map(agent => (_jsxs("tr", { className: `bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 ${agent.isOvernight ? 'bg-purple-50 dark:bg-purple-900/20' : ''}`, children: [_jsxs("td", { className: "py-4 px-6 font-medium text-gray-900 whitespace-nowrap dark:text-white", children: [agent.userDisplayName, agent.isOvernight && _jsx("div", { className: "text-xs text-purple-600 dark:text-purple-400", children: "Previous Day Start" })] }), _jsx("td", { className: "py-4 px-6", children: getStatusBadge(agent) }), _jsx("td", { className: "py-4 px-6", children: (agent.lateMinutes ?? 0) > 0 ? (_jsxs("span", { className: "text-red-600 font-bold", children: [agent.lateMinutes ?? 0, " min Late"] })) : (_jsx("span", { className: "text-green-600", children: "On Time" })) }), _jsx("td", { className: "py-4 px-6 text-center font-mono whitespace-nowrap text-xs", children: formatDateTime(agent.clockInTime) }), _jsx("td", { className: "py-4 px-6 text-center font-mono whitespace-nowrap text-xs", children: agent.status === 'clocked_out' ? (formatDateTime(agent.clockOutTime)) : (_jsx("span", { className: "text-blue-500 animate-pulse", children: "Active..." })) }), _jsx("td", { className: "py-4 px-6 font-mono font-bold text-gray-700 dark:text-gray-200", children: formatDuration(agent.displayWork) }), _jsx("td", { className: "py-4 px-6 font-mono", children: formatDuration(agent.displayBreak) }), _jsxs("td", { className: "py-4 px-6 flex gap-2 items-center", children: [_jsx("button", { onClick: () => setSelectedLog(agent), className: "font-medium text-blue-600 dark:text-blue-500 hover:underline", children: "View" }), _jsx("button", { onClick: () => setEditingLog(agent), className: "font-medium text-indigo-600 dark:text-indigo-400 hover:underline", title: "Edit Time Log", children: "Edit" }), canRequestStreamForAgent(agent) && (_jsx("button", { onClick: () => handleLiveStream(agent), className: "font-medium text-emerald-600 dark:text-emerald-400 hover:underline", title: "Request Live Screen", children: "Live" })), (agent.isZombie || (agent.status !== 'clocked_out' && !isToday)) && (_jsx("button", { onClick: () => handleForceClose(agent), className: "font-medium text-red-600 dark:text-red-400 hover:underline", title: "Force Close Session", children: "Close" }))] })] }, agent.id))) : (_jsx("tr", { children: _jsx("td", { colSpan: 8, className: "py-4 px-6 text-center text-gray-500 dark:text-gray-400", children: "No activity found." }) })) })] }) })] }));
};
export default LiveMonitoringDashboard;
