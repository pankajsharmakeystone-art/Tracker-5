import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Utility to transform Firestore worklog doc with breaks array to ActivitySheet format
export function transformFirestoreWorklog(docData) {
    const toDate = (ts) => {
        if (!ts)
            return null;
        if (ts instanceof Date)
            return ts;
        if (typeof ts.toDate === 'function')
            return ts.toDate();
        if (typeof ts === 'object' && ts.seconds)
            return new Date(ts.seconds * 1000);
        return new Date(ts);
    };
    const getMillis = (ts) => {
        if (!ts)
            return 0;
        if (typeof ts.toMillis === 'function')
            return ts.toMillis();
        if (ts instanceof Date)
            return ts.getTime();
        if (ts && typeof ts.seconds === 'number')
            return ts.seconds * 1000;
        return new Date(ts).getTime();
    };
    // If it has a breaks array, use that structure
    if (Array.isArray(docData.breaks)) {
        const segments = [];
        const mainStart = toDate(docData.startTime);
        const mainEnd = toDate(docData.endTime);
        // Build events timeline similar to older logic
        const events = [];
        (docData.breaks || []).forEach((b) => {
            if (b.startTime)
                events.push({ time: b.startTime, type: 'START_BREAK' });
            if (b.endTime)
                events.push({ time: b.endTime, type: 'END_BREAK' });
        });
        if (docData.clockOutTime)
            events.push({ time: docData.clockOutTime, type: 'CLOCK_OUT' });
        events.sort((a, b) => {
            const aMs = getMillis(a.time);
            const bMs = getMillis(b.time);
            return aMs - bMs;
        });
        let cursor = docData.clockInTime;
        let currentStatus = 'Working';
        for (const ev of events) {
            const cursorMs = getMillis(cursor);
            const evMs = getMillis(ev.time);
            if (evMs > cursorMs) {
                segments.push({
                    type: currentStatus,
                    startTime: toDate(cursor),
                    endTime: toDate(ev.time),
                    durationSeconds: (evMs - cursorMs) / 1000,
                });
            }
            cursor = ev.time;
            if (ev.type === 'START_BREAK')
                currentStatus = 'On Break';
            else if (ev.type === 'END_BREAK')
                currentStatus = 'Working';
        }
        if (docData.status !== 'clocked_out') {
            const now = typeof Timestamp !== 'undefined' ? Timestamp.now() : new Date();
            const cursorMs = getMillis(cursor);
            const nowMs = getMillis(now);
            if (nowMs > cursorMs) {
                segments.push({
                    type: docData.status === 'working' ? 'Working' : 'On Break',
                    startTime: toDate(cursor),
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
        .map(([, segment]) => ({
        segment,
        startTime: toDate(segment.startTime),
    }))
        .sort((a, b) => (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0))
        .map(({ segment }) => {
        const start = toDate(segment.startTime);
        const end = toDate(segment.endTime);
        return {
            type: (segment.type || 'Working'),
            startTime: start,
            endTime: end,
            durationSeconds: end && start ? (end.getTime() - start.getTime()) / 1000 : 0,
        };
    });
    return segments;
}
import { Timestamp } from 'firebase/firestore';
const toDate = (ts) => {
    if (!ts)
        return null;
    // Firestore Timestamp
    if (ts instanceof Timestamp)
        return ts.toDate();
    // If object has .toDate(), use it
    if (typeof ts.toDate === 'function')
        return ts.toDate();
    // Already a JS date
    if (ts instanceof Date)
        return ts;
    // Number timestamp
    if (typeof ts === 'number')
        return new Date(ts);
    return null;
};
const formatTime = (date) => {
    if (!date)
        return 'N/A';
    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};
const formatDuration = (seconds) => {
    if (seconds < 0)
        seconds = 0;
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
};
// Usage: Instead of passing workLog.activities/breaks, use transformFirestoreWorklog(workLog)
const ActivitySheet = ({ workLog }) => {
    // If workLog is already in the expected format, skip transform
    const timeline = (Array.isArray(workLog) ? workLog : transformFirestoreWorklog(workLog)).slice().reverse();
    if (timeline.length === 0) {
        return (_jsx("p", { className: "text-gray-500 dark:text-gray-400 text-center py-4", children: "No activity recorded for this session." }));
    }
    return (_jsx("div", { className: "overflow-x-auto relative sm:rounded-lg", children: _jsxs("table", { className: "w-full text-sm text-left text-gray-500 dark:text-gray-400", children: [_jsx("thead", { className: "text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400", children: _jsxs("tr", { children: [_jsx("th", { className: "py-3 px-6", children: "Activity" }), _jsx("th", { className: "py-3 px-6", children: "Start Time" }), _jsx("th", { className: "py-3 px-6", children: "End Time" }), _jsx("th", { className: "py-3 px-6", children: "Duration" })] }) }), _jsx("tbody", { children: timeline.map((seg, i) => (_jsxs("tr", { className: "bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600", children: [_jsx("td", { className: "py-4 px-6 font-medium whitespace-nowrap", children: seg.type === 'Working' ? (_jsx("span", { className: "text-green-800 dark:text-green-300 font-bold", children: "Working" })) : (_jsx("span", { className: "text-yellow-800 dark:text-yellow-300 font-bold", children: "On Break" })) }), _jsx("td", { className: "py-4 px-6", children: formatTime(seg.startTime) }), _jsx("td", { className: "py-4 px-6", children: seg.endTime ? (formatTime(seg.endTime)) : (_jsx("span", { className: "text-blue-600 dark:text-blue-400 font-semibold animate-pulse", children: "Ongoing" })) }), _jsx("td", { className: "py-4 px-6 font-mono", children: formatDuration(seg.durationSeconds) })] }, i))) })] }) }));
};
export default ActivitySheet;
