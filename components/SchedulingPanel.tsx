
import React, { useState, useEffect, useMemo } from 'react';
import { streamScheduleForMonth, updateScheduleForMonth, streamUsersByTeam, streamGlobalAdminSettings } from '../services/db';
import type { MonthlySchedule, UserData, ShiftTime, ShiftEntry, AdminSettingsType } from '../types';
import { hasRole } from '../utils/roles';
import Spinner from './Spinner';

interface Props {
  teamId: string;
}

const SchedulingPanel: React.FC<Props> = ({ teamId }) => {
    const [users, setUsers] = useState<UserData[]>([]);
    const [schedule, setSchedule] = useState<MonthlySchedule>({});
    const [currentDate, setCurrentDate] = useState(new Date());
    const [loading, setLoading] = useState(true);
    const [adminSettings, setAdminSettings] = useState<AdminSettingsType | null>(null);
    const [statsDate, setStatsDate] = useState<Date>(new Date());
    
    // Spreadsheet-like state
    const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
    const [editingCell, setEditingCell] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState<ShiftTime>({ startTime: '09:00', endTime: '17:00' });
    const [copiedValue, setCopiedValue] = useState<ShiftEntry | null>(null);
    const [lastSelectedCell, setLastSelectedCell] = useState<string | null>(null);

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysInMonth = useMemo(() => new Date(year, month + 1, 0).getDate(), [year, month]);
    const daysArray = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);
    const dayHeaders = useMemo(() => {
        return daysArray.map((day) => {
            const dateObj = new Date(year, month, day);
            const dd = String(day).padStart(2, '0');
            const mm = String(month + 1).padStart(2, '0');
            const yy = String(year).slice(-2);
            const dateLabel = `${dd}-${mm}-${yy}`;
            const dayLabel = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
            return { day, dateLabel, dayLabel };
        });
    }, [daysArray, month, year]);

    const userIndexMap = useMemo(() => new Map(users.map((user, index) => [user.uid, index])), [users]);
    const dayIndexMap = useMemo(() => new Map(daysArray.map((day, index) => [day, index])), [daysArray]);
    const statsDateStr = `${statsDate.getFullYear()}-${String(statsDate.getMonth() + 1).padStart(2, '0')}-${String(statsDate.getDate()).padStart(2, '0')}`;
    const statsDisplayDate = `${String(statsDate.getDate()).padStart(2, '0')}-${String(statsDate.getMonth() + 1).padStart(2, '0')}-${String(statsDate.getFullYear()).slice(-2)}`;
    const statsDayLabel = statsDate.toLocaleDateString('en-US', { weekday: 'short' });
    const isViewingStatsMonth = year === statsDate.getFullYear() && month === statsDate.getMonth();
    const selectedRosterStats = useMemo(() => {
        if (!isViewingStatsMonth) return null;

        const shiftCounts = new Map<string, number>();
        let offCount = 0;
        let leaveCount = 0;
        let unassignedCount = 0;
        let rosteredCount = 0;

        users.forEach((user) => {
            const value = schedule[user.uid]?.[statsDateStr];
            if (!value) {
                unassignedCount += 1;
                return;
            }

            if (value === 'OFF') {
                offCount += 1;
                return;
            }

            if (value === 'L') {
                leaveCount += 1;
                return;
            }

            rosteredCount += 1;
            const shiftKey = `${value.startTime} - ${value.endTime}`;
            shiftCounts.set(shiftKey, (shiftCounts.get(shiftKey) || 0) + 1);
        });

        const shifts = Array.from(shiftCounts.entries())
            .map(([label, count]) => ({ label, count }))
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

        return {
            totalAgents: users.length,
            rosteredCount,
            offCount,
            leaveCount,
            unassignedCount,
            shifts
        };
    }, [isViewingStatsMonth, schedule, statsDateStr, users]);

    const handleStatsDateChange = (value: string) => {
        if (!value) return;
        const nextDate = new Date(`${value}T00:00:00`);
        if (Number.isNaN(nextDate.getTime())) return;
        setStatsDate(nextDate);
        setCurrentDate(new Date(nextDate.getFullYear(), nextDate.getMonth(), 1));
    };

    useEffect(() => {
        setLoading(true);
        
        // Stream users for the team (real-time)
        const unsubscribeUsers = streamUsersByTeam(teamId, (usersData) => {
            setUsers(usersData.filter(u => hasRole(u, 'agent')));
        });

        // Stream schedule for the month (real-time)
        const unsubscribeSchedule = streamScheduleForMonth(teamId, year, month + 1, (scheduleData) => {
            setSchedule(scheduleData);
            setLoading(false);
        });

        const unsubscribeSettings = streamGlobalAdminSettings(setAdminSettings);

        return () => {
            unsubscribeUsers();
            unsubscribeSchedule();
            unsubscribeSettings();
        };
    }, [teamId, year, month]);

    const handleBulkScheduleUpdate = async (updates: { userId: string, date: string, value: ShiftEntry | null }[]) => {
        const newSchedule = JSON.parse(JSON.stringify(schedule)); // Deep copy for mutation
        updates.forEach(({ userId, date, value }) => {
            if (!newSchedule[userId]) {
                newSchedule[userId] = {};
            }
            if (value === null) {
                delete newSchedule[userId][date];
            } else {
                newSchedule[userId][date] = value;
            }
        });
        // Optimistic update
        setSchedule(newSchedule);
        try {
            await updateScheduleForMonth(teamId, year, month + 1, newSchedule, {
                timezone: adminSettings?.organizationTimezone
            });
        } catch (error) {
            console.error("Failed to update schedule", error);
            // In a real app, we might revert state here, but the stream will likely correct it or we re-fetch
        }
    };

    const handleCellClick = (cellId: string, e: React.MouseEvent) => {
        setEditingCell(null); // Exit editing mode on any click
        const newSelected = new Set(selectedCells);

        if (e.shiftKey && lastSelectedCell) {
            // Select range
            const [startUserId, startDayStr] = lastSelectedCell.split('_');
            const [endUserId, endDayStr] = cellId.split('_');
            
            const startUserIndex = userIndexMap.get(startUserId) ?? 0;
            const endUserIndex = userIndexMap.get(endUserId) ?? 0;
            const startDayIndex = dayIndexMap.get(parseInt(startDayStr, 10)) ?? 0;
            const endDayIndex = dayIndexMap.get(parseInt(endDayStr, 10)) ?? 0;

            newSelected.clear();
            for (let i = Math.min(startUserIndex, endUserIndex); i <= Math.max(startUserIndex, endUserIndex); i++) {
                for (let j = Math.min(startDayIndex, endDayIndex); j <= Math.max(startDayIndex, endDayIndex); j++) {
                    const user = users[i];
                    const day = daysArray[j];
                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    newSelected.add(`${user.uid}_${dateStr}`);
                }
            }
        } else if (e.ctrlKey || e.metaKey) {
            // Toggle single cell
            if (newSelected.has(cellId)) {
                newSelected.delete(cellId);
            } else {
                newSelected.add(cellId);
            }
        } else {
            // Select single cell
            newSelected.clear();
            newSelected.add(cellId);
        }
        
        setSelectedCells(newSelected);
        setLastSelectedCell(cellId);
    };

    const handleCellDoubleClick = (cellId: string, currentValue: ShiftEntry | undefined) => {
        setSelectedCells(new Set([cellId]));
        setEditingCell(cellId);
        if (currentValue && typeof currentValue === 'object') {
            setEditingValue(currentValue);
        } else {
            setEditingValue({ startTime: '09:00', endTime: '17:00' });
        }
    };

    const handleSaveEdit = () => {
        if (!editingCell) return;
        const [userId, date] = editingCell.split('_');
        handleBulkScheduleUpdate([{ userId, date, value: editingValue }]);
        setEditingCell(null);
    };

    const handleSetOff = () => {
        if (!editingCell) return;
        const [userId, date] = editingCell.split('_');
        handleBulkScheduleUpdate([{ userId, date, value: 'OFF' }]);
        setEditingCell(null);
    };

    const handleSetLeave = () => {
        if (!editingCell) return;
        const [userId, date] = editingCell.split('_');
        handleBulkScheduleUpdate([{ userId, date, value: 'L' }]);
        setEditingCell(null);
    };
    
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (editingCell) {
                 if (e.key === 'Escape') setEditingCell(null);
                 if (e.key === 'Enter') handleSaveEdit();
                 return;
            }

            // Copy
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                if (typeof lastSelectedCell === 'string') {
                    const [userId, date] = lastSelectedCell.split('_');
                    const value = schedule[userId]?.[date];
                    if (value) {
                       setCopiedValue(value);
                    }
                }
            }

            // Paste
            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                if (copiedValue && selectedCells.size > 0) {
                    const updates = Array.from(selectedCells).map((cellId: string) => {
                        const [userId, date] = cellId.split('_');
                        return { userId, date, value: copiedValue };
                    });
                    handleBulkScheduleUpdate(updates);
                }
            }

            // Delete
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedCells.size > 0) {
                    const updates = Array.from(selectedCells).map((cellId: string) => {
                        const [userId, date] = cellId.split('_');
                        return { userId, date, value: null };
                    });
                    handleBulkScheduleUpdate(updates);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedCells, lastSelectedCell, schedule, copiedValue, editingCell, editingValue]);


    const renderHeader = () => {
        const monthName = currentDate.toLocaleString('default', { month: 'long' });
        return (
            <div className="flex items-center justify-between mb-4">
                <button onClick={() => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() - 1)))} className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600">&lt;</button>
                <h3 className="text-xl font-semibold">{monthName} {year}</h3>
                <button onClick={() => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() + 1)))} className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600">&gt;</button>
            </div>
        );
    };

    const renderTable = () => {
        return (
            <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
                <table className="w-full text-sm text-left text-gray-500 dark:text-gray-400 border-collapse">
                    <thead className="text-xs text-gray-700 uppercase bg-gray-100 dark:bg-gray-700 dark:text-gray-400">
                        <tr>
                            <th className="py-3 px-2 sticky left-0 bg-gray-100 dark:bg-gray-700 z-20 w-40 min-w-[160px]">Agent</th>
                            {dayHeaders.map(({ day, dateLabel, dayLabel }) => (
                                <th key={day} className="py-2 px-2 text-center w-28 min-w-[112px]">
                                    <div className="leading-tight">
                                        <div className="text-[11px] font-semibold">{dateLabel}</div>
                                        <div className="text-[10px] font-medium normal-case opacity-80">{dayLabel}</div>
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(user => (
                            <tr key={user.uid} className="bg-white dark:bg-gray-800">
                                <td className="py-2 px-2 font-medium text-gray-900 dark:text-white sticky left-0 bg-white dark:bg-gray-800 z-10 border-b border-r dark:border-gray-700">{user.displayName}</td>
                                {daysArray.map(day => {
                                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                                    const cellId = `${user.uid}_${dateStr}`;
                                    const value = schedule[user.uid]?.[dateStr];
                                    const isSelected = selectedCells.has(cellId);
                                    const isEditing = editingCell === cellId;

                                    return (
                                        <td key={dateStr}
                                            onClick={(e) => handleCellClick(cellId, e)}
                                            onDoubleClick={() => handleCellDoubleClick(cellId, value)}
                                            className={`py-1 px-1 text-center border-b dark:border-gray-700 cursor-pointer relative ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
                                        >
                                           <div className={`w-full h-full absolute inset-0 border-2 ${isSelected ? 'border-blue-500' : 'border-transparent'} pointer-events-none`}></div>
                                           {isEditing ? (
                                                <div className="p-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg" onClick={e => e.stopPropagation()}>
                                                    <div className="flex gap-1 items-center justify-center mb-1">
                                                        <input type="time" value={editingValue.startTime} onChange={e => setEditingValue({...editingValue, startTime: e.target.value})} className="w-full p-1 text-xs border-gray-300 rounded-md dark:bg-gray-700 dark:border-gray-600"/>
                                                        <span>-</span>
                                                        <input type="time" value={editingValue.endTime} onChange={e => setEditingValue({...editingValue, endTime: e.target.value})} className="w-full p-1 text-xs border-gray-300 rounded-md dark:bg-gray-700 dark:border-gray-600"/>
                                                    </div>
                                                    <div className="flex gap-1 justify-end text-xs">
                                                        <button onClick={handleSetOff} className="px-2 py-1 rounded bg-gray-200 dark:bg-gray-600 hover:bg-gray-300">OFF</button>
                                                        <button onClick={handleSetLeave} className="px-2 py-1 rounded bg-purple-200 text-purple-800 dark:bg-purple-900 dark:text-purple-200 hover:bg-purple-300">Leave</button>
                                                        <button onClick={() => setEditingCell(null)} className="px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600">Cancel</button>
                                                        <button onClick={handleSaveEdit} className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700">Save</button>
                                                    </div>
                                                </div>
                                           ) : (
                                                <div className="h-12 flex items-center justify-center">
                                                {value ? (
                                                    value === 'OFF' ? (
                                                        <span className="text-red-500 font-semibold">OFF</span>
                                                    ) : value === 'L' ? (
                                                        <span className="text-purple-500 font-semibold">LEAVE</span>
                                                    ) : (
                                                        <span className="font-mono text-xs">{`${value.startTime} - ${value.endTime}`}</span>
                                                    )
                                                ) : '--'}
                                                </div>
                                           )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    };

    if (loading) {
        return <div className="flex justify-center items-center p-8"><Spinner /></div>;
    }

    return (
        <div>
            <div className="p-4 mb-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border dark:border-gray-700">
                <div className="flex flex-col lg:flex-row gap-4 lg:items-start lg:justify-between">
                    <div className="min-w-0">
                        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">How to Use the Scheduler</h3>
                        <ul className="list-disc list-inside text-sm text-gray-600 dark:text-gray-400 space-y-1">
                            <li><span className="font-semibold">Double-click</span> a cell to edit or create a custom shift.</li>
                            <li><span className="font-semibold">Click</span> to select a cell, <span className="font-semibold">Shift+Click</span> to select a range, and <span className="font-semibold">Ctrl/Cmd+Click</span> to select multiple cells.</li>
                            <li>Use <span className="font-semibold">Ctrl/Cmd+C</span> to copy, <span className="font-semibold">Ctrl/Cmd+V</span> to paste, and <span className="font-semibold">Delete</span> key to clear a schedule.</li>
                        </ul>
                    </div>
                    <div className="w-full lg:w-[360px] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Roster Snapshot</h4>
                        <div className="mb-3">
                            <label htmlFor="roster-stats-date" className="block text-[11px] font-medium text-gray-600 dark:text-gray-300 mb-1">
                                Select date
                            </label>
                            <input
                                id="roster-stats-date"
                                type="date"
                                value={statsDateStr}
                                onChange={(e) => handleStatsDateChange(e.target.value)}
                                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-900 dark:text-gray-100"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{statsDayLabel}, {statsDisplayDate}</p>
                        </div>
                        {!isViewingStatsMonth || !selectedRosterStats ? (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                Loading selected month roster stats...
                            </p>
                        ) : (
                            <>
                                <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
                                    <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-2 py-1">
                                        <div className="text-[10px] uppercase tracking-wide text-blue-700 dark:text-blue-300">Rostered</div>
                                        <div className="text-sm font-semibold text-blue-800 dark:text-blue-200">{selectedRosterStats.rosteredCount}</div>
                                    </div>
                                    <div className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-2 py-1">
                                        <div className="text-[10px] uppercase tracking-wide text-gray-600 dark:text-gray-400">Off</div>
                                        <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">{selectedRosterStats.offCount}</div>
                                    </div>
                                    <div className="rounded border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/30 px-2 py-1">
                                        <div className="text-[10px] uppercase tracking-wide text-purple-700 dark:text-purple-300">Leave</div>
                                        <div className="text-sm font-semibold text-purple-800 dark:text-purple-200">{selectedRosterStats.leaveCount}</div>
                                    </div>
                                    <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-2 py-1">
                                        <div className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">Unassigned</div>
                                        <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">{selectedRosterStats.unassignedCount}</div>
                                    </div>
                                </div>
                                <div className="text-xs text-gray-600 dark:text-gray-300">
                                    <div className="font-semibold mb-1">Shift-wise</div>
                                    {selectedRosterStats.shifts.length === 0 ? (
                                        <div className="text-gray-500 dark:text-gray-400">No shift timings assigned today.</div>
                                    ) : (
                                        <ul className="space-y-1">
                                            {selectedRosterStats.shifts.map((shift) => (
                                                <li key={shift.label} className="flex items-center justify-between">
                                                    <span className="font-mono">{shift.label}</span>
                                                    <span className="font-semibold">{shift.count}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 font-medium flex items-center justify-between">
                                        <span>Total agents</span>
                                        <span>{selectedRosterStats.totalAgents}</span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
            {renderHeader()}
            {renderTable()}
        </div>
    );
};

export default SchedulingPanel;
