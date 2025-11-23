import React from 'react';
import type { WorkLog } from '../types';
import { Timestamp } from 'firebase/firestore';

interface Props {
    workLog: WorkLog;
}

const formatTime = (timestamp: Timestamp | null): string => {
    if (!timestamp) return 'N/A';
    return timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const formatDuration = (seconds: number): string => {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
};

interface Activity {
    type: 'Working' | 'On Break';
    startTime: Timestamp;
    endTime: Timestamp | null;
    durationSeconds: number | null;
}

const ActivitySheet: React.FC<Props> = ({ workLog }) => {
    const buildActivityTimeline = (): Activity[] => {
        if (!workLog || !workLog.clockInTime) {
            return [];
        }

        const timeline: Activity[] = [];
        let cursor = workLog.clockInTime;

        // Collect all discrete events in chronological order
        const allEvents: { time: Timestamp, type: 'START_BREAK' | 'END_BREAK' | 'CLOCK_OUT' }[] = [];

        workLog.breaks.forEach(b => {
            allEvents.push({ time: b.startTime, type: 'START_BREAK' });
            if (b.endTime) {
                allEvents.push({ time: b.endTime, type: 'END_BREAK' });
            }
        });

        if (workLog.clockOutTime) {
            allEvents.push({ time: workLog.clockOutTime, type: 'CLOCK_OUT' });
        }
        
        allEvents.sort((a, b) => a.time.seconds - b.time.seconds);
        
        let currentStatus: 'Working' | 'On Break' = 'Working';

        for (const event of allEvents) {
            // If there's a gap between the cursor and the event, it was an activity period
            if (event.time.seconds > cursor.seconds) {
                const duration = event.time.seconds - cursor.seconds;
                timeline.push({
                    type: currentStatus,
                    startTime: cursor,
                    endTime: event.time,
                    durationSeconds: duration,
                });
            }

            cursor = event.time;
            
            if (event.type === 'START_BREAK') {
                currentStatus = 'On Break';
            } else if (event.type === 'END_BREAK') {
                currentStatus = 'Working';
            }
        }

        // Add the final, ongoing activity if the user is not clocked out
        if (workLog.status !== 'clocked_out') {
            const now = Timestamp.now();
            if (now.seconds > cursor.seconds) {
                 const duration = now.seconds - cursor.seconds;
                 timeline.push({
                    type: workLog.status === 'working' ? 'Working' : 'On Break',
                    startTime: cursor,
                    endTime: null, // This period is ongoing
                    durationSeconds: duration,
                 });
            }
        }

        return timeline.reverse(); // Show most recent activity first
    };

    const activities = buildActivityTimeline();

    if (activities.length === 0) {
        return <p className="text-gray-500 dark:text-gray-400 text-center py-4">No activity to display for today.</p>;
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
                        <tr key={index} className="bg-white border-b dark:bg-gray-800 dark:border-gray-700">
                            <td className="py-4 px-6 font-medium whitespace-nowrap">
                                {activity.type === 'Working' ? (
                                    <span className="text-green-800 dark:text-green-300">Working</span>
                                ) : (
                                    <span className="text-yellow-800 dark:text-yellow-300">On Break</span>
                                )}
                            </td>
                            <td className="py-4 px-6">{formatTime(activity.startTime)}</td>
                            <td className="py-4 px-6">{activity.endTime ? formatTime(activity.endTime) : <span className="text-blue-500 dark:text-blue-400">Now</span>}</td>
                            <td className="py-4 px-6 font-mono">{activity.durationSeconds != null ? formatDuration(activity.durationSeconds) : '...'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default ActivitySheet;
