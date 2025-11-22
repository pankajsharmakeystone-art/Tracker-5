// Utility to transform Firestore worklog doc with breaks array to ActivitySheet format
export function transformFirestoreWorklog(docData: any): Array<{
    type: 'Working' | 'On Break';
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number;
}> {
    const toDate = (ts: any): Date | null => {
        if (!ts) return null;
        if (ts instanceof Date) return ts;
        if (typeof ts.toDate === 'function') return ts.toDate();
        if (typeof ts === 'object' && ts.seconds) return new Date(ts.seconds * 1000);
        return new Date(ts);
    };

    // If it has a breaks array, use that structure
    if (Array.isArray(docData.breaks)) {
        const segments = [];
        
        const mainStart = toDate(docData.startTime);
        const mainEnd = toDate(docData.endTime);
        
        // Add main working period
        if (mainStart) {
            segments.push({
                type: 'Working' as const,
                startTime: mainStart,
                endTime: mainEnd,
                durationSeconds: mainEnd && mainStart ? (mainEnd.getTime() - mainStart.getTime()) / 1000 : 0,
            });
        }
        
        // Add breaks
        (docData.breaks || []).forEach((breakItem: any) => {
            const breakStart = toDate(breakItem.startTime);
            const breakEnd = toDate(breakItem.endTime);
            segments.push({
                type: 'On Break' as const,
                startTime: breakStart!,
                endTime: breakEnd,
                durationSeconds: breakEnd && breakStart ? (breakEnd.getTime() - breakStart.getTime()) / 1000 : 0,
            });
        });
        
        // Sort by startTime (oldest first)
        segments.sort((a, b) => (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0));
        return segments;
    }
    
    // Fallback: if it has numeric keys (old structure)
    const segments = Object.entries(docData)
        .filter(([key]) => !isNaN(Number(key)))
        .map(([, segment]: [string, any]) => ({
            segment,
            startTime: toDate(segment.startTime),
        }))
        .sort((a, b) => (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0))
        .map(({ segment }) => {
            const start = toDate(segment.startTime);
            const end = toDate(segment.endTime);
            return {
                type: (segment.type || 'Working') as 'Working' | 'On Break',
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
    
    // Debug: Check what structure we received
    console.log('=== ActivitySheet Debug ===');
    console.log('Has breaks array?', Array.isArray(workLog?.breaks));
    console.log('Has numeric keys?', Object.keys(workLog || {}).some(k => !isNaN(Number(k))));
    console.log('Numeric keys:', Object.keys(workLog || {}).filter(k => !isNaN(Number(k))).slice(0, 3));
    console.log('Timeline length:', timeline.length);
    console.log('First timeline item:', timeline[0]);

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
                                    <span className="text-yellow-800 dark:text-yellow-300 font-bold">On Break</span>
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
