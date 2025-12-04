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

    const getMillis = (ts: any): number => {
        if (!ts) return 0;
        if (typeof (ts as any).toMillis === 'function') return (ts as any).toMillis();
        if (ts instanceof Date) return ts.getTime();
        if (ts && typeof ts.seconds === 'number') return ts.seconds * 1000;
        return new Date(ts).getTime();
    };

    const normalizeClockOutTime = (clockOut: any, clockIn: any) => {
        if (!clockOut) return null;
        const startMs = getMillis(clockIn);
        const endMs = getMillis(clockOut);
        if (!startMs || !endMs) return clockOut;
        if (endMs > startMs) return clockOut;
        const MAX_ROLL_THRESHOLD_MS = 6 * 60 * 60 * 1000; // tolerate small rounding or edits
        if ((startMs - endMs) <= MAX_ROLL_THRESHOLD_MS) return clockOut;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const diff = startMs - endMs;
        const increments = Math.floor(diff / DAY_MS) + 1;
        return new Date(endMs + increments * DAY_MS);
    };

    // If it has a breaks array, use that structure
    if (Array.isArray(docData.breaks)) {
        const segments = [] as any[];
        const clockOutForTimeline = normalizeClockOutTime(docData.clockOutTime, docData.clockInTime);

        // Build events timeline similar to older logic
        const events: { time: any; type: 'START_BREAK' | 'END_BREAK' | 'CLOCK_OUT' }[] = [];
        (docData.breaks || []).forEach((b: any) => {
            if (b.startTime) events.push({ time: b.startTime, type: 'START_BREAK' });
            if (b.endTime) events.push({ time: b.endTime, type: 'END_BREAK' });
        });
        if (clockOutForTimeline) events.push({ time: clockOutForTimeline, type: 'CLOCK_OUT' });

        events.sort((a, b) => {
            const aMs = getMillis(a.time);
            const bMs = getMillis(b.time);
            return aMs - bMs;
        });

        let cursor = docData.clockInTime;
        let currentStatus: 'Working' | 'On Break' = 'Working';

        for (const ev of events) {
            const cursorMs = getMillis(cursor);
            const evMs = getMillis(ev.time);
            if (evMs > cursorMs) {
                segments.push({
                    type: currentStatus,
                    startTime: toDate(cursor)!,
                    endTime: toDate(ev.time),
                    durationSeconds: (evMs - cursorMs) / 1000,
                });
            }
            cursor = ev.time;
            if (ev.type === 'START_BREAK') currentStatus = 'On Break';
            else if (ev.type === 'END_BREAK') currentStatus = 'Working';
        }

        if (docData.status !== 'clocked_out') {
            const now = typeof Timestamp !== 'undefined' ? Timestamp.now() : new Date();
            const cursorMs = getMillis(cursor);
            const nowMs = getMillis(now);
            if (nowMs > cursorMs) {
                segments.push({
                    type: docData.status === 'working' ? 'Working' : 'On Break',
                    startTime: toDate(cursor)!,
                    endTime: null,
                    durationSeconds: (nowMs - cursorMs) / 1000,
                });
            }
        }

        return segments.sort((a, b) => (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0));
    }

    // Fallback for numeric keyed structure
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
    const timeline = (Array.isArray(workLog) ? workLog : transformFirestoreWorklog(workLog)).slice().reverse();

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
