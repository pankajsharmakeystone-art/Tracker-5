// Utility to transform Firestore worklog doc with numeric keys to ActivitySheet format
export function transformFirestoreWorklog(docData: any): Array<{
    type: 'Working' | 'Break';
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number;
}> {
    // Get all numeric keys
    const segments = Object.keys(docData)
        .filter(key => !isNaN(Number(key)))
        .map(key => docData[key])
        .sort((a, b) => {
            const aStart = a.startTime instanceof Date ? a.startTime : new Date(a.startTime?.seconds ? a.startTime.seconds * 1000 : a.startTime);
            const bStart = b.startTime instanceof Date ? b.startTime : new Date(b.startTime?.seconds ? b.startTime.seconds * 1000 : b.startTime);
            return aStart.getTime() - bStart.getTime();
        })
        .map((segment, idx) => {
            // Convert Firestore Timestamp or string to Date
            const toDate = (ts: any): Date | null => {
                if (!ts) return null;
                if (ts instanceof Date) return ts;
                if (typeof ts.toDate === 'function') return ts.toDate();
                if (typeof ts === 'object' && ts.seconds) return new Date(ts.seconds * 1000);
                return new Date(ts);
            };
            const start = toDate(segment.startTime);
            const end = toDate(segment.endTime);
            return {
                type: (idx % 2 === 0 ? 'Working' : 'Break') as 'Working' | 'Break',
                startTime: start!,
                endTime: end,
                durationSeconds: end && start ? (end.getTime() - start.getTime()) / 1000 : 0,
            };
        });
    return segments;
}

import React from 'react';
import { Timestamp } from 'firebase/firestore';
import type { WorkLog } from '../types';

interface Props {
    workLog: WorkLog;
}

interface Segment {
    type: 'Working' | 'Break';
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number;
}

const toDate = (ts: any): Date | null => {
    if (!ts) return null;

    // Firestore Timestamp
    if (ts instanceof Timestamp) return ts.toDate();

    // If object has .toDate(), use it
    if (typeof ts.toDate === 'function') return ts.toDate();

    // Already a JS date
    if (ts instanceof Date) return ts;

    // Number timestamp
    if (typeof ts === 'number') return new Date(ts);

    return null;
};

const formatTime = (date: Date | null): string => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};

const formatDuration = (seconds: number): string => {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
};


// Usage: Instead of passing workLog.activities/breaks, use transformFirestoreWorklog(workLog)
const ActivitySheet: React.FC<{ workLog: any }> = ({ workLog }) => {
    // If workLog is already in the expected format, skip transform
    const timeline = Array.isArray(workLog)
        ? workLog
        : transformFirestoreWorklog(workLog);

    if (timeline.length === 0) {
        return (
            <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                No activity recorded for this session.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto relative sm:rounded-lg">
            <table className="w-full text-sm text-left text-gray-500 dark:text-gray-400">
                <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
                    <tr>
                        <th className="py-3 px-6">Activity</th>
                        <th className="py-3 px-6">Start Time</th>
                        <th className="py-3 px-6">End Time</th>
                        <th className="py-3 px-6">Duration</th>
                    </tr>
                </thead>

                <tbody>
                    {timeline.map((seg, i) => (
                        <tr
                            key={i}
                            className="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                        >
                            {/* Activity type */}
                            <td className="py-4 px-6 font-medium whitespace-nowrap">
                                {seg.type === 'Working' ? (
                                    <span className="text-green-800 dark:text-green-300 font-bold">Working</span>
                                ) : (
                                    <span className="text-yellow-800 dark:text-yellow-300 font-bold">Break</span>
                                )}
                            </td>

                            {/* Start time */}
                            <td className="py-4 px-6">{formatTime(seg.startTime)}</td>

                            {/* End time */}
                            <td className="py-4 px-6">
                                {seg.endTime ? (
                                    formatTime(seg.endTime)
                                ) : (
                                    <span className="text-blue-600 dark:text-blue-400 font-semibold animate-pulse">
                                        Ongoing
                                    </span>
                                )}
                            </td>

                            {/* Duration */}
                            <td className="py-4 px-6 font-mono">
                                {formatDuration(seg.durationSeconds)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default ActivitySheet;
