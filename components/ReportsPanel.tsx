import React, { useState, useEffect } from 'react';
import { getWorkLogsForDateRange, getUsersByTeam } from '../services/db';
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

const ReportsPanel: React.FC<Props> = ({ teamId }) => {
    const today = new Date().toISOString().split('T')[0];
    const [startDate, setStartDate] = useState(today);
    const [endDate, setEndDate] = useState(today);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [users, setUsers] = useState<UserData[]>([]);
    const [selectedUserId, setSelectedUserId] = useState('all'); // 'all' or a user UID

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
            let csvContent = "data:text/csv;charset=utf-8,Date,User Name,Total Work Time,Total Break Time\n";
            logs.forEach((log: WorkLog) => {
                const logDate = (log.date as any).toDate().toISOString().split('T')[0];
                const workTime = formatDuration(log.totalWorkSeconds);
                const breakTime = formatDuration(log.totalBreakSeconds);
                csvContent += `${logDate},"${log.userDisplayName}",${workTime},${breakTime}\n`;
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