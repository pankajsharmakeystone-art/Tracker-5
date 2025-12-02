
import React, { useState, useEffect, useMemo } from 'react';
import { Timestamp } from 'firebase/firestore';
import { streamTodayWorkLogs, streamWorkLogsForDate, isSessionStale, closeStaleSession, updateWorkLog } from '../services/db';
import { useAuth } from '../hooks/useAuth';
import type { WorkLog } from '../types';
import Spinner from './Spinner';
import LiveStreamModal from './LiveStreamModal';

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

const formatDateTime = (timestamp: Timestamp | null | undefined): string => {
    if (!timestamp) return 'N/A';
    return timestamp.toDate().toLocaleString([], { 
        month: 'numeric', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    });
};

// Helper for datetime-local input
const toDatetimeLocal = (timestamp: Timestamp | null | undefined) => {
    if (!timestamp) return '';
    const d = timestamp.toDate();
    const pad = (n: number) => n.toString().padStart(2, '0');
    // Includes seconds for precision editing
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const EditTimeModal = ({ log, onClose }: { log: WorkLog, onClose: () => void }) => {
    const [startTime, setStartTime] = useState(toDatetimeLocal(log.clockInTime));
    const [endTime, setEndTime] = useState(toDatetimeLocal(log.clockOutTime));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
            const updates: any = {
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
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Leave empty to keep session active.</p>
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

const LiveMonitoringDashboard: React.FC<Props> = ({ teamId }) => {
    const { userData } = useAuth();
    const [rawLogs, setRawLogs] = useState<WorkLog[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingLog, setEditingLog] = useState<WorkLog | null>(null);
    const [liveStreamAgent, setLiveStreamAgent] = useState<{ uid: string; displayName: string; teamId?: string } | null>(null);
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
        } else {
            // Historical view: strict date query
            unsubscribe = streamWorkLogsForDate(selectedDate, (logs) => {
                setRawLogs(logs);
                setLoading(false);
            }, teamId);
        }

        return () => {
            if (unsubscribe) unsubscribe();
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
                const lastTime = (log.lastEventTimestamp as any).toMillis 
                    ? (log.lastEventTimestamp as any).toMillis() 
                    : (log.lastEventTimestamp as any).toDate().getTime();
                
                const elapsed = Math.max(0, (now - lastTime) / 1000);
                
                if (log.status === 'working') totalWork += elapsed;
                else if (log.status === 'on_break' || (log.status as any) === 'break') totalBreak += elapsed;
            }
            
            // Check if this log started on a previous day
            let isOvernight = false;
            if (log.date) {
                const logDate = (log.date as any).toDate();
                const selected = new Date(selectedDate);
                // Basic check: if log date is before selected viewing date (which is usually today)
                if (logDate.setHours(0,0,0,0) < selected.setHours(0,0,0,0)) {
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

    const handleLiveStream = (log: WorkLog) => {
        if (!log?.userId || !canRequestStreamForAgent(log)) return;
        setLiveStreamAgent({ uid: log.userId, displayName: log.userDisplayName, teamId: log.teamId });
        setIsLiveModalOpen(true);
    };

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
            {editingLog && <EditTimeModal log={editingLog} onClose={() => setEditingLog(null)} />}
            
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
                            <th scope="col" className="py-3 px-6">Break Duration</th>
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
                                    {formatDateTime(agent.clockInTime)}
                                </td>
                                <td className="py-4 px-6 text-center font-mono whitespace-nowrap text-xs">
                                    {agent.status === 'clocked_out' ? (
                                        formatDateTime(agent.clockOutTime)
                                    ) : (
                                        <span className="text-blue-500 animate-pulse">Active...</span>
                                    )}
                                </td>
                                <td className="py-4 px-6 font-mono font-bold text-gray-700 dark:text-gray-200">
                                    {formatDuration(agent.displayWork)}
                                </td>
                                <td className="py-4 px-6 font-mono">
                                    {formatDuration(agent.displayBreak)}
                                </td>
                                <td className="py-4 px-6 flex gap-2 items-center">
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
                                </td>
                            </tr>
                        )) : (
                            <tr>
                                <td colSpan={8} className="py-4 px-6 text-center text-gray-500 dark:text-gray-400">
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
