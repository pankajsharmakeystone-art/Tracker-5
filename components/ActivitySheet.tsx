import React from 'react';
import { Timestamp } from 'firebase/firestore';
import type { WorkLog } from '../types';

interface Props {
    workLog: WorkLog;
}

// Helper to safely convert Firestore Timestamp or Date inputs to a JS Date object
const toDate = (ts: any): Date | null => {
    if (!ts) return null;
    if (ts instanceof Timestamp) return ts.toDate();
    if (typeof ts.toDate === 'function') return ts.toDate();
    if (ts instanceof Date) return ts;
    if (typeof ts === 'number') return new Date(ts);
    return null;
};

const formatTime = (date: Date | null): string => {
    if (!date) return 'N/A';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatDuration = (seconds: number): string => {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
};

interface ActivitySegment {
    type: 'Working' | 'On Break';
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number;
}

const ActivitySheet: React.FC<Props> = ({ workLog }) => {
    const generateTimeline = (): ActivitySegment[] => {
        // 1. Start Cursor at Clock In
        const clockIn = toDate(workLog.clockInTime);
        if (!clockIn) return [];

        const timeline: ActivitySegment[] = [];
        let cursor = clockIn;

        // 2. Sort breaks chronologically by start time
        const breaks = (workLog.breaks || []).slice().sort((a, b) => {
            const tA = toDate(a.startTime)?.getTime() || 0;
            const tB = toDate(b.startTime)?.getTime() || 0;
            return tA - tB;
        });

        // 3. Iterate through breaks to build timeline segments
        for (const brk of breaks) {
            const bStart = toDate(brk.startTime);
            const bEnd = toDate(brk.endTime);

            if (!bStart) continue;

            // A. Working Segment: From current cursor -> Break Start
            // (Only add if there is actual time elapsed)
            if (bStart.getTime() > cursor.getTime()) {
                const duration = (bStart.getTime() - cursor.getTime()) / 1000;
                timeline.push({
                    type: 'Working',
                    startTime: cursor,
                    endTime: bStart,
                    durationSeconds: duration
                });
            }

            // B. Break Segment: Break Start -> Break End
            const breakEndCalc = bEnd || new Date(); // If ongoing, calculate duration until Now
            const breakDuration = (breakEndCalc.getTime() - bStart.getTime()) / 1000;

            timeline.push({
                type: 'On Break',
                startTime: bStart,
                endTime: bEnd, // Null indicates "Ongoing"
                durationSeconds: breakDuration
            });

            // C. Move Cursor to Break End
            if (bEnd) {
                cursor = bEnd;
            } else {
                // If break is ongoing, stop the cursor at "Now" to prevent 
                // creating a subsequent working segment
                cursor = new Date();
            }
        }

        // 4. Final Working Segment: Cursor -> Clock Out (or Now)
        // Only add this if the last segment wasn't an ongoing break
        const lastSegment = timeline.length > 0 ? timeline[timeline.length - 1] : null;
        const isOngoingBreak = lastSegment?.type === 'On Break' && !lastSegment.endTime;

        if (!isOngoingBreak) {
            const clockOut = toDate(workLog.clockOutTime);
            const sessionEndCalc = clockOut || new Date(); // If active, calculate until Now

            // Ensure we don't add a segment if cursor is already at or past end time
            if (sessionEndCalc.getTime() > cursor.getTime()) {
                const duration = (sessionEndCalc.getTime() - cursor.getTime()) / 1000;
                timeline.push({
                    type: 'Working',
                    startTime: cursor,
                    endTime: clockOut, // Null indicates "Ongoing"
                    durationSeconds: duration
                });
            }
        }

        // 5. Reverse to show most recent activity at the top
        return timeline.reverse();
    };

    const activities = generateTimeline();

    if (activities.length === 0) {
        return <p className="text-gray-500 dark:text-gray-400 text-center py-4">No activity recorded for this session.</p>;
    }

    return (
        <div className="overflow-x-auto relative sm:rounded-lg">
            <table className="w-full text-sm text-left text-gray-500 dark:text-gray-400">
                <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
                    <tr>
                        <th scope="col" className="py-3 px-6">Activity</th>
                        <th scope="col" className="py-3 px-6">Start Time</th>
                        <th scope="col" className="py-3 px-6">End Time</th>
                        <th scope="col" className="py-3 px-6">Duration</th>
                    </tr>
                </thead>
                <tbody>
                    {activities.map((activity, index) => (
                        <tr key={index} className="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600">
                            <td className="py-4 px-6 font-medium whitespace-nowrap">
                                {activity.type === 'Working' ? (
                                    <span className="text-green-800 dark:text-green-300 font-bold">Working</span>
                                ) : (
                                    <span className="text-yellow-800 dark:text-yellow-300 font-bold">On Break</span>
                                )}
                            </td>
                            <td className="py-4 px-6">{formatTime(activity.startTime)}</td>
                            <td className="py-4 px-6">
                                {activity.endTime ? (
                                    formatTime(activity.endTime)
                                ) : (
                                    <span className="text-blue-600 dark:text-blue-400 font-semibold animate-pulse">
                                        Ongoing
                                    </span>
                                )}
                            </td>
                            <td className="py-4 px-6 font-mono">
                                {formatDuration(activity.durationSeconds)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default ActivitySheet;