import React, { useState, useEffect } from 'react';
import { getWorkLogsForDateRange, getUsersByTeam, streamGlobalAdminSettings } from '../services/db';
import type { WorkLog, UserData } from '../types';

interface Props {
    teamId: string;
}

// Helper to format seconds into HH:MM:SS
const formatDuration = (totalSeconds: number): string => {
    if (totalSeconds < 0) totalSeconds = 0;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return [hours, minutes, seconds]
        .map(v => v.toString().padStart(2, '0'))
        .join(':');
};

const normalizeDate = (value: any): Date | null => {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.toMillis === 'function') return new Date(value.toMillis());
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatLocalDate = (value: any, timeZone?: string | null): string => {
    const date = normalizeDate(value);
    if (!date) return '';
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    return fmt.format(date);
};

const formatTimeOfDay = (value: any, timeZone?: string | null): string => {
    const date = normalizeDate(value);
    if (!date) return '';
    return date.toLocaleTimeString(undefined, {
        timeZone: timeZone || undefined,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
};

const formatLateMinutes = (minutes?: number): string => {
    if (!minutes || minutes <= 0) return '00:00';
    const hrs = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

const deriveBreakCause = (entry: any): 'manual' | 'idle' => {
    const raw = (entry?.cause || entry?.reason || entry?.type || entry?.source || '').toString().toLowerCase();
    if (raw.includes('idle')) return 'idle';
    if (entry?.auto === true || entry?.isIdle === true) return 'idle';
    return 'manual';
};

const computeBreakBuckets = (log: WorkLog) => {
    const breaks = Array.isArray((log as any)?.breaks) ? (log as any).breaks : [];
    let manualSeconds = 0;
    let idleSeconds = 0;
    const fallbackEnd = normalizeDate(log.clockOutTime) || normalizeDate(log.lastEventTimestamp) || new Date();

    breaks.forEach((entry: any) => {
        const start = normalizeDate(entry?.startTime);
        const end = normalizeDate(entry?.endTime) || fallbackEnd;
        if (!start || !end || end <= start) return;
        const duration = (end.getTime() - start.getTime()) / 1000;
        if (deriveBreakCause(entry) === 'idle') idleSeconds += duration;
        else manualSeconds += duration;
    });

    return { manualSeconds, idleSeconds };
};

const ReportsPanel: React.FC<Props> = ({ teamId }) => {
    const today = new Date().toISOString().split('T')[0];
    const [startDate, setStartDate] = useState(today);
    const [endDate, setEndDate] = useState(today);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [users, setUsers] = useState<UserData[]>([]);
    const [selectedUserId, setSelectedUserId] = useState('all'); // 'all' or a user UID
    const [organizationTimezone, setOrganizationTimezone] = useState<string | null>(null);

    useEffect(() => {
        const fetchUsers = async () => {
            if (teamId) {
                try {
                    const teamUsers = await getUsersByTeam(teamId);
                    setUsers(teamUsers.filter(u => u.role === 'agent' || u.role === 'manager'));
                } catch (err) {
                    console.error("Failed to fetch users for report panel:", err);
                    setUsers([]);
                }
            }
        };
        fetchUsers();
    }, [teamId]);

    useEffect(() => {
        const unsubscribe = streamGlobalAdminSettings((settings) => {
            setOrganizationTimezone(settings?.organizationTimezone || null);
        });
        return () => unsubscribe?.();
    }, []);


    const handleDownload = async () => {
        if (!startDate || !endDate) {
            setError("Please select both a start and end date.");
            return;
        }
        
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        if (start > end) {
            setError("Start date cannot be after end date.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            let logs = await getWorkLogsForDateRange(teamId, start, end);
            
            // Filter if a specific user is selected
            if (selectedUserId !== 'all') {
                logs = logs.filter(log => log.userId === selectedUserId);
            }

            // Sort logs by date, then by user name
            logs.sort((a, b) => {
                const dateA = (a.date as any).toDate().getTime();
                const dateB = (b.date as any).toDate().getTime();
                if (dateA !== dateB) {
                    return dateA - dateB;
                }
                return a.userDisplayName.localeCompare(b.userDisplayName);
            });

            // Generate CSV
            let csvContent = "data:text/csv;charset=utf-8,Date,User Name,Clock In Time,Clock Out Time,Late Login (HH:MM),Total Work Time,Manual Break Time,Idle Break Time,Total Break Time\n";
            logs.forEach((log: WorkLog) => {
                const logDate = formatLocalDate(log.date, organizationTimezone);
                const workTime = formatDuration(log.totalWorkSeconds);
                const breakTime = formatDuration(log.totalBreakSeconds);
                const clockIn = formatTimeOfDay(log.clockInTime, organizationTimezone);
                const clockOut = formatTimeOfDay(log.clockOutTime, organizationTimezone);
                const lateLogin = formatLateMinutes(log.lateMinutes);
                const { manualSeconds, idleSeconds } = computeBreakBuckets(log);
                const manualBreak = formatDuration(manualSeconds);
                const idleBreak = formatDuration(idleSeconds);
                const safeClockIn = clockIn ? `"${clockIn}"` : '""';
                const safeClockOut = clockOut ? `"${clockOut}"` : '""';
                csvContent += `${logDate},"${log.userDisplayName}",${safeClockIn},${safeClockOut},${lateLogin},${workTime},${manualBreak},${idleBreak},${breakTime}\n`;
            });

            // Trigger download
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);

            let filename = `work_report_${startDate}_to_${endDate}`;
            if (selectedUserId !== 'all') {
                const selectedUserName = users.find(u => u.uid === selectedUserId)?.displayName?.replace(/\s/g, '_') || selectedUserId;
                filename += `_${selectedUserName}`;
            }
            filename += '.csv';

            link.setAttribute("download", filename);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (err) {
            console.error(err);
            setError("Failed to generate report.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700 max-w-lg">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Generate Work Log Report</h3>
            {error && <p className="text-sm text-red-500 mb-4">{error}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                    <label htmlFor="start-date" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Start Date</label>
                    <input
                        type="date"
                        id="start-date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                    />
                </div>
                <div>
                    <label htmlFor="end-date" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">End Date</label>
                    <input
                        type="date"
                        id="end-date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                    />
                </div>
            </div>
             <div className="mb-4">
                <label htmlFor="user-select" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Select User</label>
                <select
                    id="user-select"
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                    className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
                >
                    <option value="all">All Users</option>
                    {users.map(user => (
                        <option key={user.uid} value={user.uid}>{user.displayName}</option>
                    ))}
                </select>
            </div>
            <button
                onClick={handleDownload}
                disabled={loading}
                className="text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50"
            >
                {loading ? 'Generating...' : 'Download CSV'}
            </button>
        </div>
    );
};

export default ReportsPanel;