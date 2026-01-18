import React, { useState, useEffect } from 'react';
import { streamRecordingLogs, type RecordingLogEntry } from '../services/db';

interface RecordingLogsPanelProps {
    teamId?: string;
}

const RecordingLogsPanel: React.FC<RecordingLogsPanelProps> = ({ teamId }) => {
    const [logs, setLogs] = useState<RecordingLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<string>('all');

    useEffect(() => {
        setLoading(true);
        const unsubscribe = streamRecordingLogs(
            (fetchedLogs) => {
                setLogs(fetchedLogs);
                setLoading(false);
            },
            { teamId, status: statusFilter }
        );
        return () => unsubscribe();
    }, [teamId, statusFilter]);

    const formatDate = (timestamp: any): string => {
        if (!timestamp) return '-';
        try {
            const date = timestamp.toDate?.() || new Date(timestamp);
            return date.toLocaleString();
        } catch {
            return '-';
        }
    };

    const formatFileSize = (bytes: number | null): string => {
        if (!bytes) return '-';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const formatDuration = (ms: number | null): string => {
        if (!ms) return '-';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'success':
                return (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300">
                        <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        Success
                    </span>
                );
            case 'failed':
                return (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300">
                        <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                        Failed
                    </span>
                );
            case 'pending':
                return (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300">
                        <svg className="w-3 h-3 mr-1 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Pending
                    </span>
                );
            default:
                return <span className="text-gray-500 text-xs">{status}</span>;
        }
    };

    const getTargetIcon = (target: string | null) => {
        switch (target) {
            case 'dropbox':
                return <span className="text-blue-500 font-medium text-xs">Dropbox</span>;
            case 'googleSheets':
                return <span className="text-green-600 font-medium text-xs">Google</span>;
            case 'http':
                return <span className="text-purple-600 font-medium text-xs">HTTP</span>;
            default:
                return <span className="text-gray-400 text-xs">-</span>;
        }
    };

    const stats = {
        success: logs.filter(l => l.status === 'success').length,
        failed: logs.filter(l => l.status === 'failed').length,
        pending: logs.filter(l => l.status === 'pending').length,
        total: logs.length
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                <span className="ml-3 text-gray-600 dark:text-gray-300">Loading recording logs...</span>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border dark:border-gray-700 shadow-sm">
                    <div className="text-2xl font-bold text-gray-800 dark:text-white">{stats.total}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Total Logs</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border dark:border-gray-700 shadow-sm">
                    <div className="text-2xl font-bold text-green-600">{stats.success}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Successful</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border dark:border-gray-700 shadow-sm">
                    <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Failed</div>
                </div>
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border dark:border-gray-700 shadow-sm">
                    <div className="text-2xl font-bold text-yellow-600">{stats.pending}</div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Pending</div>
                </div>
            </div>

            {/* Filter */}
            <div className="flex items-center gap-4 bg-white dark:bg-gray-800 p-4 rounded-lg border dark:border-gray-700">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Filter by status:</label>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                >
                    <option value="all">All</option>
                    <option value="success">✓ Successful</option>
                    <option value="failed">✗ Failed</option>
                    <option value="pending">⏳ Pending</option>
                </select>
            </div>

            {/* Table */}
            <div className="bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900">
                            <tr>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">User</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Status</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Target</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">File</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Size</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Duration</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Stop Reason</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Machine</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Date</th>
                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {logs.length === 0 ? (
                                <tr>
                                    <td colSpan={10} className="px-4 py-8 text-center text-gray-500 dark:text-gray-400">
                                        No recording logs found
                                    </td>
                                </tr>
                            ) : (
                                logs.map((log) => (
                                    <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                                        <td className="px-4 py-3 whitespace-nowrap">
                                            <div className="text-sm font-medium text-gray-900 dark:text-white">{log.userName || 'Unknown'}</div>
                                            <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[120px]">{log.userId}</div>
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap">
                                            {getStatusBadge(log.status)}
                                            {log.error && log.status !== 'success' && (
                                                <div className="text-xs text-red-500 mt-1 max-w-[150px] truncate" title={log.error}>
                                                    {log.error}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap">
                                            {getTargetIcon(log.uploadTarget)}
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="text-sm text-gray-700 dark:text-gray-300 truncate max-w-[200px]" title={log.fileName}>
                                                {log.fileName}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                                            {formatFileSize(log.fileSize)}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                                            {formatDuration(log.durationMs)}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm">
                                            {(log as any).stopReason ? (
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${(log as any).stopReason === 'lock-screen' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300' :
                                                    (log as any).stopReason === 'manual_break' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300' :
                                                        (log as any).stopReason === 'clocked_out' ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300' :
                                                            'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                                                    }`}>
                                                    {(log as any).stopReason.replace(/_/g, ' ').replace(/-/g, ' ')}
                                                </span>
                                            ) : (
                                                <span className="text-gray-400">-</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                                            {log.machineName || '-'}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400">
                                            {formatDate(log.loggedAt)}
                                        </td>
                                        <td className="px-4 py-3 whitespace-nowrap">
                                            {log.downloadUrl && log.status === 'success' ? (
                                                <a
                                                    href={log.downloadUrl.startsWith('dropbox:') ? undefined : log.downloadUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm font-medium"
                                                    title={log.downloadUrl}
                                                >
                                                    View
                                                </a>
                                            ) : log.status === 'pending' ? (
                                                <span className="text-xs text-yellow-600 dark:text-yellow-400">Awaiting owner login</span>
                                            ) : (
                                                <span className="text-gray-400 text-sm">-</span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default RecordingLogsPanel;
