
import React, { useState, useEffect, useMemo } from 'react';
import { streamScheduleForMonth, updateScheduleForMonth, streamUsersByTeam, streamGlobalAdminSettings } from '../services/db';
import type { MonthlySchedule, UserData, ShiftTime, ShiftEntry, AdminSettingsType } from '../types';
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

    useEffect(() => {
        setLoading(true);
        
        // Stream users for the team (real-time)
        const unsubscribeUsers = streamUsersByTeam(teamId, (usersData) => {
            setUsers(usersData.filter(u => u.role === 'agent'));
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
                <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">How to Use the Scheduler</h3>
                <ul className="list-disc list-inside text-sm text-gray-600 dark:text-gray-400 space-y-1">
                    <li><span className="font-semibold">Double-click</span> a cell to edit or create a custom shift.</li>
                    <li><span className="font-semibold">Click</span> to select a cell, <span className="font-semibold">Shift+Click</span> to select a range, and <span className="font-semibold">Ctrl/Cmd+Click</span> to select multiple cells.</li>
                    <li>Use <span className="font-semibold">Ctrl/Cmd+C</span> to copy, <span className="font-semibold">Ctrl/Cmd+V</span> to paste, and <span className="font-semibold">Delete</span> key to clear a schedule.</li>
                </ul>
            </div>
            {renderHeader()}
            {renderTable()}
        </div>
    );
};

export default SchedulingPanel;
