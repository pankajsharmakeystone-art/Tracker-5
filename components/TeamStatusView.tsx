
import React, { useState, useEffect, useMemo } from 'react';
import { streamTodayWorkLogs, streamAllAgentStatuses, streamGlobalAdminSettings, sendCommandToDesktop } from '../services/db';
import { streamAllPresence, isPresenceFresh } from '../services/presence';
import type { WorkLog, AdminSettingsType } from '../types';
import Spinner from './Spinner';
import { Timestamp } from 'firebase/firestore';

interface Props {
    teamId?: string;
    currentUserId?: string;
    isMinimizable?: boolean;
    canControlRecording?: boolean; // New prop to restrict access to controls
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

const getStatusIndicator = (status: WorkLog['status']) => {
    switch (status) {
        case 'working':
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Working</span>;
        case 'on_break':
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">On Break</span>;
        case 'clocked_out':
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">Offline</span>;
        default:
            return <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200">Unknown</span>;
    }
};

const normalizeStatus = (raw: any): WorkLog['status'] => {
    const val = String(raw || '').toLowerCase();
    if (val === 'working' || val === 'online' || val === 'active') return 'working';
    if (val === 'on_break' || val === 'break') return 'on_break';
    return 'clocked_out';
};

const TeamStatusView: React.FC<Props> = ({ teamId, currentUserId, isMinimizable = false, canControlRecording = false }) => {
    const [isMinimized, setIsMinimized] = useState(false);
    const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
    const [agentStatuses, setAgentStatuses] = useState<Record<string, any>>({});
    const [presence, setPresence] = useState<Record<string, any>>({});
    const [adminSettings, setAdminSettings] = useState<AdminSettingsType | null>(null);
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

        // Stream RTDB presence (preferred for realtime "desktop connected")
        const unsubscribePresence = streamAllPresence((p) => {
            setPresence(p || {});
        });

        // Stream settings to check recording mode
        const unsubscribeSettings = streamGlobalAdminSettings((settings) => {
            setAdminSettings(settings);
        });

        return () => {
            unsubscribeWorkLogs();
            unsubscribeAgentStatuses();
            unsubscribePresence();
            unsubscribeSettings();
        };
    }, [teamId]);

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(interval);
    }, []);

    const handleStartRecording = async (uid: string) => {
        await sendCommandToDesktop(uid, 'startRecording');
    };

    const handleStopRecording = async (uid: string) => {
        await sendCommandToDesktop(uid, 'stopRecording');
    };

    // Deduplicate logs by userId to ensure one row per agent in this status view
    const uniqueAgentLogs = useMemo(() => {
        const agentMap = new Map<string, WorkLog>();
        
        workLogs.forEach(log => {
            const existing = agentMap.get(log.userId);
            if (!existing) {
                agentMap.set(log.userId, log);
                return;
            }
            
            // Logic: Prioritize 'Working'/'On Break' over 'Clocked Out'
            // If both are active or both inactive, pick the one with the later start time
            
            const isNewActive = log.status === 'working' || log.status === 'on_break' || (log.status as any) === 'break';
            const isExistingActive = existing.status === 'working' || existing.status === 'on_break' || (existing.status as any) === 'break';
            
            if (isNewActive && !isExistingActive) {
                agentMap.set(log.userId, log);
            } else if (isNewActive === isExistingActive) {
                // Tie-breaker: latest start time
                const newTime = log.startTime ? (log.startTime as any).toMillis?.() || 0 : 0;
                const existingTime = existing.startTime ? (existing.startTime as any).toMillis?.() || 0 : 0;
                if (newTime > existingTime) {
                    agentMap.set(log.userId, log);
                }
            }
        });
        
        return Array.from(agentMap.values());
    }, [workLogs]);

    const workingCount = uniqueAgentLogs.filter(log => log.status === 'working').length;
    const onBreakCount = uniqueAgentLogs.filter(log => log.status === 'on_break' || (log.status as any) === 'break').length;

    // Sort logs to show the current user on top, then alphabetical
    const displayLogs = [...uniqueAgentLogs].sort((a, b) => {
        if (a.userId === currentUserId) return -1;
        if (b.userId === currentUserId) return 1;
        return a.userDisplayName.localeCompare(b.userDisplayName);
    });

    const showRecordingControls = canControlRecording && adminSettings?.recordingMode === 'manual';

    return (
        <div className="mb-8 bg-white dark:bg-gray-800/50 shadow-md rounded-xl border dark:border-gray-700">
            <div 
                className={`px-6 py-4 flex justify-between items-center ${isMinimizable ? 'cursor-pointer' : ''}`}
                onClick={() => isMinimizable && setIsMinimized(!isMinimized)}
                aria-expanded={!isMinimized}
            >
                <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
                    Live Team Status
                </h3>
                {isMinimizable && (
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsMinimized(!isMinimized); }}
                        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-gray-800"
                        aria-label={isMinimized ? 'Expand team status' : 'Collapse team status'}
                    >
                        {isMinimized ? <i className="fa-solid fa-chevron-down"></i> : <i className="fa-solid fa-chevron-up"></i>}
                    </button>
                )}
            </div>

            {!isMinimized && (
                <div className="p-6 border-t dark:border-gray-700">
                    {loading ? (
                        <div className="flex justify-center items-center p-8"><Spinner /></div>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
                                <div className="p-6 bg-green-50 dark:bg-green-900/40 rounded-xl shadow-sm">
                                    <p className="text-base font-medium text-gray-700 dark:text-green-200">Agents Working</p>
                                    <p className="text-5xl font-bold text-gray-800 dark:text-white mt-2">
                                        {workingCount}
                                    </p>
                                </div>
                                <div className="p-6 bg-yellow-50 dark:bg-yellow-900/40 rounded-xl shadow-sm">
                                    <p className="text-base font-medium text-gray-700 dark:text-yellow-200">Agents on Break</p>
                                    <p className="text-5xl font-bold text-gray-800 dark:text-white mt-2">
                                        {onBreakCount}
                                    </p>
                                </div>
                            </div>

                            <div className="rounded-xl overflow-hidden border dark:border-gray-700">
                                <div className="px-6 py-4 bg-gray-50 dark:bg-gray-700/50 border-b dark:border-gray-700">
                                    <div className="flex justify-between items-center text-sm font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">
                                        <span>Team Member</span>
                                        <div className="flex items-center gap-4">
                                            {showRecordingControls && <span className="w-32 text-center">Controls</span>}
                                            <span className="w-32 text-right">Status / Duration</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="divide-y divide-gray-200 dark:divide-gray-700">
                                     {(displayLogs.length > 0) ? displayLogs.map(log => {
                                        const duration = (log.status === 'working' || log.status === 'on_break' || (log.status as any) === 'break') && log.lastEventTimestamp
                                            ? formatDuration(Math.max(0, Math.floor((now - (log.lastEventTimestamp as Timestamp).toDate().getTime()) / 1000)))
                                            : null;
                                    
                                        const agentStatus = agentStatuses[log.userId];
                                        const presenceEntry = presence?.[log.userId];
                                        const lastUpdateRaw = agentStatus?.lastUpdate;
                                        const lastUpdateMs = lastUpdateRaw?.toMillis
                                            ? lastUpdateRaw.toMillis()
                                            : (lastUpdateRaw?.toDate ? lastUpdateRaw.toDate().getTime() : null);
                                        const isConnected = (
                                            (presenceEntry?.state === 'online'
                                                && isPresenceFresh(presenceEntry?.lastSeen, now, 12 * 60 * 1000))
                                            || (typeof lastUpdateMs === 'number' && (now - lastUpdateMs) <= 12 * 60 * 1000)
                                        );

                                        // Status must come from worklogs only (single source of truth).
                                        const displayStatus = normalizeStatus(log.status);
                                        const displayRecording = isConnected && agentStatus?.isRecording === true;

                                        return (
                                            <div 
                                                key={log.id} 
                                                className={`px-6 py-4 flex justify-between items-center hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors duration-150 ${log.userId === currentUserId ? 'bg-blue-50 dark:bg-blue-900/40' : ''}`}
                                            >
                                                <div className="flex flex-col">
                                                    <span className="font-medium text-gray-900 dark:text-white">
                                                        {log.userDisplayName}
                                                        {log.userId === currentUserId && <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">(You)</span>}
                                                    </span>
                                                    <div className="mt-1">
                                                        <span className="text-xs text-gray-500 dark:text-gray-400">{isConnected ? 'Desktop' : 'Web'}</span>
                                                    </div>
                                                </div>
                                                
                                                <div className="flex items-center gap-4 flex-wrap justify-end">
                                                    {showRecordingControls && (
                                                        <div className="flex items-center gap-2 w-32 justify-center">
                                                            <button
                                                                onClick={() => handleStartRecording(log.userId)}
                                                                disabled={!isConnected || displayRecording}
                                                                className="p-1.5 bg-blue-100 text-blue-600 rounded hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-900"
                                                                title="Start Recording"
                                                            >
                                                                <i className="fa-solid fa-video"></i>
                                                            </button>
                                                            <button
                                                                onClick={() => handleStopRecording(log.userId)}
                                                                disabled={!isConnected || !displayRecording}
                                                                className="p-1.5 bg-red-100 text-red-600 rounded hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900"
                                                                title="Stop Recording"
                                                            >
                                                                <i className="fa-solid fa-stop"></i>
                                                            </button>
                                                        </div>
                                                    )}

                                                    <div className="flex items-center gap-4 w-32 justify-end">
                                                        {getStatusIndicator(displayStatus as any)}
                                                        <span className="font-mono text-sm text-gray-500 dark:text-gray-400 w-16 text-right">
                                                            {duration || '--:--'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                     }) : (
                                         <div className="px-6 py-4 text-center text-gray-500 dark:text-gray-400">
                                            No agent activity recorded for today.
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default TeamStatusView;
