// Utility to transform Firestore worklog doc with breaks array to ActivitySheet format
export function transformFirestoreWorklog(docData: any): Array<{
    type: 'Working' | 'On Break' | 'System Event' | 'Clock Out';
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number;
    cause?: 'manual' | 'idle' | 'away' | 'screen_lock';
    isSystemEvent?: boolean;
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

    if (Array.isArray(docData.activities) && docData.activities.length > 0) {
        console.log('[ActivitySheet] Using ACTIVITIES path. activities:', docData.activities.length, 'breaks:', docData.breaks?.length || 0);
        const nowDate = typeof Timestamp !== 'undefined' ? Timestamp.now().toDate() : new Date();
        const nowMs = nowDate.getTime();

        // Collect all system events from breaks array
        const systemEvents: Array<{ startTime: Date; endTime: Date | null; cause?: string; }> = [];
        if (Array.isArray(docData.breaks)) {
            docData.breaks
                .filter((b: any) => b && b.startTime && b.isSystemEvent)
                .forEach((b: any) => {
                    const start = toDate(b.startTime);
                    if (start) {
                        systemEvents.push({
                            startTime: start,
                            endTime: toDate(b.endTime),
                            cause: b.cause,
                        });
                    }
                });
        }

        // Sort system events by start time
        systemEvents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

        // Build timeline by processing activities and splitting around system events
        const segments: Array<{
            type: 'Working' | 'On Break' | 'System Event' | 'Clock Out';
            startTime: Date;
            endTime: Date | null;
            durationSeconds: number;
            cause?: 'manual' | 'idle' | 'away' | 'screen_lock';
            isSystemEvent?: boolean;
        }> = [];

        // Process each activity entry
        docData.activities
            .filter((entry: any) => entry && entry.startTime)
            .forEach((entry: any) => {
                const activityStart = toDate(entry.startTime);
                if (!activityStart) return;
                const activityEnd = toDate(entry.endTime) ?? nowDate;
                const normalizedType = (entry.type || '').toLowerCase() === 'on_break' ? 'On Break' : 'Working';
                const isBreak = normalizedType === 'On Break';

                // If it's a break or already a system event, add directly
                if (isBreak || entry.isSystemEvent) {
                    const durationSeconds = Math.max(0, (activityEnd.getTime() - activityStart.getTime()) / 1000);
                    const cause = entry.cause === 'idle' ? 'idle' : entry.cause === 'away' ? 'away' : entry.cause === 'manual' ? 'manual' : entry.cause === 'screen_lock' ? 'screen_lock' : undefined;
                    segments.push({
                        type: entry.isSystemEvent ? 'System Event' : 'On Break',
                        startTime: activityStart,
                        endTime: toDate(entry.endTime) ?? null,
                        durationSeconds,
                        cause,
                        isSystemEvent: entry.isSystemEvent || false,
                    });
                    return;
                }

                // For Working entries, split around system events
                let cursor = activityStart;
                const activityEndMs = activityEnd.getTime();

                // Find system events that overlap with this activity
                for (const sysEvent of systemEvents) {
                    const sysStartMs = sysEvent.startTime.getTime();
                    const sysEndMs = sysEvent.endTime?.getTime() ?? nowMs;

                    // If system event is before this activity, skip
                    if (sysEndMs <= cursor.getTime()) continue;
                    // If system event is after this activity ends, stop
                    if (sysStartMs >= activityEndMs) break;

                    // Add working segment from cursor to system event start
                    if (sysStartMs > cursor.getTime()) {
                        const workDuration = (sysStartMs - cursor.getTime()) / 1000;
                        segments.push({
                            type: 'Working',
                            startTime: cursor,
                            endTime: sysEvent.startTime,
                            durationSeconds: Math.max(0, workDuration),
                        });
                    }

                    // Add the system event
                    const sysDuration = (sysEndMs - sysStartMs) / 1000;
                    segments.push({
                        type: 'System Event',
                        startTime: sysEvent.startTime,
                        endTime: sysEvent.endTime,
                        durationSeconds: Math.max(0, sysDuration),
                        cause: sysEvent.cause as 'screen_lock' | undefined,
                        isSystemEvent: true,
                    });

                    // Move cursor past the system event
                    cursor = sysEvent.endTime ?? nowDate;
                }

                // Add remaining working time after all system events
                if (cursor.getTime() < activityEndMs) {
                    const remainingDuration = (activityEndMs - cursor.getTime()) / 1000;
                    segments.push({
                        type: 'Working',
                        startTime: cursor,
                        endTime: toDate(entry.endTime) ?? null,
                        durationSeconds: Math.max(0, remainingDuration),
                    });
                }
            });

        // Add Clock Out entry if session has ended
        if (docData.status === 'clocked_out' && docData.clockOutTime) {
            const clockOutDate = toDate(normalizeClockOutTime(docData.clockOutTime, docData.clockInTime));
            if (clockOutDate) {
                segments.push({
                    type: 'Clock Out' as any,
                    startTime: clockOutDate,
                    endTime: null,
                    durationSeconds: 0,
                });
            }
        }

        // Sort by start time
        return segments.sort((a, b) => (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0));
    }

    // If it has a breaks array, use that structure
    if (Array.isArray(docData.breaks)) {
        // Debug: Log all breaks with screen_lock cause
        const screenLockEntries = docData.breaks.filter((b: any) => b?.cause === 'screen_lock');
        if (screenLockEntries.length > 0) {
            console.log('[ActivitySheet] Breaks with screen_lock cause:', screenLockEntries);
        } else {
            console.log('[ActivitySheet] No screen_lock entries found. Total breaks:', docData.breaks.length);
        }

        const segments: Array<{
            type: 'Working' | 'On Break' | 'System Event';
            startTime: Date;
            endTime: Date | null;
            durationSeconds: number;
            cause?: 'manual' | 'idle' | 'away' | 'screen_lock';
            isSystemEvent?: boolean;
        }> = [];

        const nowDate = typeof Timestamp !== 'undefined' ? Timestamp.now().toDate() : new Date();
        const nowMs = nowDate.getTime();
        const sessionStart = toDate(docData.clockInTime);
        let cursor = sessionStart;

        const pushWorkingSegment = (start: Date | null, end: Date | null) => {
            if (!start || !end) return;
            const startMs = start.getTime();
            const endMs = end.getTime();
            if (!isFinite(startMs) || !isFinite(endMs) || endMs <= startMs) return;
            segments.push({
                type: 'Working',
                startTime: start,
                endTime: end,
                durationSeconds: (endMs - startMs) / 1000,
            });
        };

        type BreakWithIndex = { entry: any; index: number };

        const sortedBreaks = (docData.breaks || [])
            .map((entry: any, index: number): BreakWithIndex => ({ entry, index }))
            .filter(({ entry }: BreakWithIndex) => entry && entry.startTime)
            .sort((a: BreakWithIndex, b: BreakWithIndex) => {
                const diff = getMillis(a.entry.startTime) - getMillis(b.entry.startTime);
                return diff !== 0 ? diff : a.index - b.index;
            })
            .map(({ entry }: BreakWithIndex) => entry);

        sortedBreaks.forEach((breakEntry: any) => {
            const breakStart = toDate(breakEntry.startTime);
            if (!breakStart) return;

            // Debug: Log system events
            if (breakEntry?.isSystemEvent) {
                console.log('[ActivitySheet] Found system event:', breakEntry);
            }

            if (cursor && breakStart.getTime() > cursor.getTime()) {
                pushWorkingSegment(cursor, breakStart);
            }

            const breakEnd = toDate(breakEntry.endTime);
            let durationSeconds = 0;

            if (breakEnd) {
                const diff = breakEnd.getTime() - breakStart.getTime();
                if (diff > 0) durationSeconds = diff / 1000;
            } else if (nowMs > breakStart.getTime()) {
                durationSeconds = (nowMs - breakStart.getTime()) / 1000;
            }

            segments.push({
                type: breakEntry?.isSystemEvent ? 'System Event' : 'On Break',
                startTime: breakStart,
                endTime: breakEnd ?? null,
                durationSeconds,
                cause: breakEntry?.cause,
                isSystemEvent: breakEntry?.isSystemEvent || false,
            });

            cursor = breakEnd ?? null;
        });

        const resolveSessionEnd = (): Date | null => {
            if (docData.status === 'clocked_out') {
                const normalized = normalizeClockOutTime(docData.clockOutTime, docData.clockInTime);
                return toDate(normalized);
            }

            if (docData.status === 'on_break' || docData.status === 'break') {
                return null;
            }

            return nowDate;
        };

        const sessionEnd = resolveSessionEnd();

        if (cursor && sessionEnd && sessionEnd.getTime() > cursor.getTime()) {
            pushWorkingSegment(cursor, sessionEnd);
        }

        return segments;
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
import { DateTime } from 'luxon';
import { Timestamp } from 'firebase/firestore';
import type { WorkLog } from '../types';

interface Props {
    workLog: WorkLog;
    timezone?: string;
}

interface Segment {
    type: 'Working' | 'On Break';
    startTime: Date;
    endTime: Date | null;
    durationSeconds: number;
    cause?: 'manual' | 'idle' | 'away';
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

const formatTime = (date: Date | null, timezone?: string): string => {
    if (!date) return 'N/A';
    const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return DateTime.fromJSDate(date).setZone(zone, { keepLocalTime: false }).toFormat('hh:mm:ss a');
};

const formatDuration = (seconds: number): string => {
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
};


// Usage: Instead of passing workLog.activities/breaks, use transformFirestoreWorklog(workLog)
const ActivitySheet: React.FC<{ workLog: any, timezone?: string }> = ({ workLog, timezone }) => {
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
                                ) : seg.type === 'Clock Out' ? (
                                    <span className="text-red-700 dark:text-red-400 font-bold flex items-center">
                                        <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                                        </svg>
                                        Clock Out
                                    </span>
                                ) : seg.type === 'System Event' || seg.isSystemEvent ? (
                                    <span className="text-purple-700 dark:text-purple-300 font-bold flex items-center">
                                        <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                        </svg>
                                        System Event: Screen Locked
                                    </span>
                                ) : (
                                    <span className="text-yellow-800 dark:text-yellow-300 font-bold">
                                        {seg.cause ? `On Break (${seg.cause === 'idle' ? 'Idle' : seg.cause === 'away' ? 'Away' : 'Manual'})` : 'On Break'}
                                    </span>
                                )}
                            </td>

                            {/* Start time / Clock Out time */}
                            <td className="py-4 px-6">
                                {seg.type === 'Clock Out'
                                    ? formatTime(seg.startTime, timezone)
                                    : formatTime(seg.startTime, timezone)
                                }
                            </td>

                            {/* End time */}
                            <td className="py-4 px-6">
                                {seg.type === 'Clock Out' ? (
                                    <span className="text-gray-400">--</span>
                                ) : seg.endTime ? (
                                    formatTime(seg.endTime, timezone)
                                ) : (
                                    <span className="text-blue-600 dark:text-blue-400 font-semibold animate-pulse">
                                        Ongoing
                                    </span>
                                )}
                            </td>

                            {/* Duration */}
                            <td className="py-4 px-6 font-mono">
                                {seg.type === 'Clock Out' ? (
                                    <span className="text-gray-400">--</span>
                                ) : (
                                    formatDuration(seg.durationSeconds)
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default ActivitySheet;
