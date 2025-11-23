import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Timestamp } from 'firebase/firestore';
const formatTime = (timestamp) => {
    if (!timestamp)
        return 'N/A';
    return timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const formatDuration = (seconds) => {
    if (seconds < 0)
        seconds = 0;
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
};
const ActivitySheet = ({ workLog }) => {
    const buildActivityTimeline = () => {
        if (!workLog || !workLog.clockInTime) {
            return [];
        }
        const timeline = [];
        let cursor = workLog.clockInTime;
        // Collect all discrete events in chronological order
        const allEvents = [];
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
        let currentStatus = 'Working';
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
            }
            else if (event.type === 'END_BREAK') {
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
        return _jsx("p", { className: "text-gray-500 dark:text-gray-400 text-center py-4", children: "No activity to display for today." });
    }
    return (_jsx("div", { className: "overflow-x-auto relative sm:rounded-lg", children: _jsxs("table", { className: "w-full text-sm text-left text-gray-500 dark:text-gray-400", children: [_jsx("thead", { className: "text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400", children: _jsxs("tr", { children: [_jsx("th", { scope: "col", className: "py-3 px-6", children: "Activity" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Start Time" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "End Time" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Duration" })] }) }), _jsx("tbody", { children: activities.map((activity, index) => (_jsxs("tr", { className: "bg-white border-b dark:bg-gray-800 dark:border-gray-700", children: [_jsx("td", { className: "py-4 px-6 font-medium whitespace-nowrap", children: activity.type === 'Working' ? (_jsx("span", { className: "text-green-800 dark:text-green-300", children: "Working" })) : (_jsx("span", { className: "text-yellow-800 dark:text-yellow-300", children: "On Break" })) }), _jsx("td", { className: "py-4 px-6", children: formatTime(activity.startTime) }), _jsx("td", { className: "py-4 px-6", children: activity.endTime ? formatTime(activity.endTime) : _jsx("span", { className: "text-blue-500 dark:text-blue-400", children: "Now" }) }), _jsx("td", { className: "py-4 px-6 font-mono", children: activity.durationSeconds != null ? formatDuration(activity.durationSeconds) : '...' })] }, index))) })] }) }));
};
export default ActivitySheet;
