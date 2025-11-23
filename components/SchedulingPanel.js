import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useMemo } from 'react';
import { streamScheduleForMonth, updateScheduleForMonth, streamUsersByTeam } from '../services/db';
import Spinner from './Spinner';
const SchedulingPanel = ({ teamId }) => {
    const [users, setUsers] = useState([]);
    const [schedule, setSchedule] = useState({});
    const [currentDate, setCurrentDate] = useState(new Date());
    const [loading, setLoading] = useState(true);
    // Spreadsheet-like state
    const [selectedCells, setSelectedCells] = useState(new Set());
    const [editingCell, setEditingCell] = useState(null);
    const [editingValue, setEditingValue] = useState({ startTime: '09:00', endTime: '17:00' });
    const [copiedValue, setCopiedValue] = useState(null);
    const [lastSelectedCell, setLastSelectedCell] = useState(null);
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysInMonth = useMemo(() => new Date(year, month + 1, 0).getDate(), [year, month]);
    const daysArray = useMemo(() => Array.from({ length: daysInMonth }, (_, i) => i + 1), [daysInMonth]);
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
        return () => {
            unsubscribeUsers();
            unsubscribeSchedule();
        };
    }, [teamId, year, month]);
    const handleBulkScheduleUpdate = async (updates) => {
        const newSchedule = JSON.parse(JSON.stringify(schedule)); // Deep copy for mutation
        updates.forEach(({ userId, date, value }) => {
            if (!newSchedule[userId]) {
                newSchedule[userId] = {};
            }
            if (value === null) {
                delete newSchedule[userId][date];
            }
            else {
                newSchedule[userId][date] = value;
            }
        });
        // Optimistic update
        setSchedule(newSchedule);
        try {
            await updateScheduleForMonth(teamId, year, month + 1, newSchedule);
        }
        catch (error) {
            console.error("Failed to update schedule", error);
            // In a real app, we might revert state here, but the stream will likely correct it or we re-fetch
        }
    };
    const handleCellClick = (cellId, e) => {
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
        }
        else if (e.ctrlKey || e.metaKey) {
            // Toggle single cell
            if (newSelected.has(cellId)) {
                newSelected.delete(cellId);
            }
            else {
                newSelected.add(cellId);
            }
        }
        else {
            // Select single cell
            newSelected.clear();
            newSelected.add(cellId);
        }
        setSelectedCells(newSelected);
        setLastSelectedCell(cellId);
    };
    const handleCellDoubleClick = (cellId, currentValue) => {
        setSelectedCells(new Set([cellId]));
        setEditingCell(cellId);
        if (currentValue && typeof currentValue === 'object') {
            setEditingValue(currentValue);
        }
        else {
            setEditingValue({ startTime: '09:00', endTime: '17:00' });
        }
    };
    const handleSaveEdit = () => {
        if (!editingCell)
            return;
        const [userId, date] = editingCell.split('_');
        handleBulkScheduleUpdate([{ userId, date, value: editingValue }]);
        setEditingCell(null);
    };
    const handleSetOff = () => {
        if (!editingCell)
            return;
        const [userId, date] = editingCell.split('_');
        handleBulkScheduleUpdate([{ userId, date, value: 'OFF' }]);
        setEditingCell(null);
    };
    const handleSetLeave = () => {
        if (!editingCell)
            return;
        const [userId, date] = editingCell.split('_');
        handleBulkScheduleUpdate([{ userId, date, value: 'L' }]);
        setEditingCell(null);
    };
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (editingCell) {
                if (e.key === 'Escape')
                    setEditingCell(null);
                if (e.key === 'Enter')
                    handleSaveEdit();
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
                    const updates = Array.from(selectedCells).map((cellId) => {
                        const [userId, date] = cellId.split('_');
                        return { userId, date, value: copiedValue };
                    });
                    handleBulkScheduleUpdate(updates);
                }
            }
            // Delete
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedCells.size > 0) {
                    const updates = Array.from(selectedCells).map((cellId) => {
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
        return (_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("button", { onClick: () => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() - 1))), className: "px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600", children: "<" }), _jsxs("h3", { className: "text-xl font-semibold", children: [monthName, " ", year] }), _jsx("button", { onClick: () => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() + 1))), className: "px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600", children: ">" })] }));
    };
    const renderTable = () => {
        return (_jsx("div", { className: "overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg", children: _jsxs("table", { className: "w-full text-sm text-left text-gray-500 dark:text-gray-400 border-collapse", children: [_jsx("thead", { className: "text-xs text-gray-700 uppercase bg-gray-100 dark:bg-gray-700 dark:text-gray-400", children: _jsxs("tr", { children: [_jsx("th", { className: "py-3 px-2 sticky left-0 bg-gray-100 dark:bg-gray-700 z-20 w-40 min-w-[160px]", children: "Agent" }), daysArray.map(day => _jsx("th", { className: "py-3 px-2 text-center w-28 min-w-[112px]", children: day }, day))] }) }), _jsx("tbody", { children: users.map(user => (_jsxs("tr", { className: "bg-white dark:bg-gray-800", children: [_jsx("td", { className: "py-2 px-2 font-medium text-gray-900 dark:text-white sticky left-0 bg-white dark:bg-gray-800 z-10 border-b border-r dark:border-gray-700", children: user.displayName }), daysArray.map(day => {
                                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                                    const cellId = `${user.uid}_${dateStr}`;
                                    const value = schedule[user.uid]?.[dateStr];
                                    const isSelected = selectedCells.has(cellId);
                                    const isEditing = editingCell === cellId;
                                    return (_jsxs("td", { onClick: (e) => handleCellClick(cellId, e), onDoubleClick: () => handleCellDoubleClick(cellId, value), className: `py-1 px-1 text-center border-b dark:border-gray-700 cursor-pointer relative ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`, children: [_jsx("div", { className: `w-full h-full absolute inset-0 border-2 ${isSelected ? 'border-blue-500' : 'border-transparent'} pointer-events-none` }), isEditing ? (_jsxs("div", { className: "p-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg", onClick: e => e.stopPropagation(), children: [_jsxs("div", { className: "flex gap-1 items-center justify-center mb-1", children: [_jsx("input", { type: "time", value: editingValue.startTime, onChange: e => setEditingValue({ ...editingValue, startTime: e.target.value }), className: "w-full p-1 text-xs border-gray-300 rounded-md dark:bg-gray-700 dark:border-gray-600" }), _jsx("span", { children: "-" }), _jsx("input", { type: "time", value: editingValue.endTime, onChange: e => setEditingValue({ ...editingValue, endTime: e.target.value }), className: "w-full p-1 text-xs border-gray-300 rounded-md dark:bg-gray-700 dark:border-gray-600" })] }), _jsxs("div", { className: "flex gap-1 justify-end text-xs", children: [_jsx("button", { onClick: handleSetOff, className: "px-2 py-1 rounded bg-gray-200 dark:bg-gray-600 hover:bg-gray-300", children: "OFF" }), _jsx("button", { onClick: handleSetLeave, className: "px-2 py-1 rounded bg-purple-200 text-purple-800 dark:bg-purple-900 dark:text-purple-200 hover:bg-purple-300", children: "Leave" }), _jsx("button", { onClick: () => setEditingCell(null), className: "px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600", children: "Cancel" }), _jsx("button", { onClick: handleSaveEdit, className: "px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700", children: "Save" })] })] })) : (_jsx("div", { className: "h-12 flex items-center justify-center", children: value ? (value === 'OFF' ? (_jsx("span", { className: "text-red-500 font-semibold", children: "OFF" })) : value === 'L' ? (_jsx("span", { className: "text-purple-500 font-semibold", children: "LEAVE" })) : (_jsx("span", { className: "font-mono text-xs", children: `${value.startTime} - ${value.endTime}` }))) : '--' }))] }, dateStr));
                                })] }, user.uid))) })] }) }));
    };
    if (loading) {
        return _jsx("div", { className: "flex justify-center items-center p-8", children: _jsx(Spinner, {}) });
    }
    return (_jsxs("div", { children: [_jsxs("div", { className: "p-4 mb-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border dark:border-gray-700", children: [_jsx("h3", { className: "text-lg font-medium text-gray-900 dark:text-white mb-2", children: "How to Use the Scheduler" }), _jsxs("ul", { className: "list-disc list-inside text-sm text-gray-600 dark:text-gray-400 space-y-1", children: [_jsxs("li", { children: [_jsx("span", { className: "font-semibold", children: "Double-click" }), " a cell to edit or create a custom shift."] }), _jsxs("li", { children: [_jsx("span", { className: "font-semibold", children: "Click" }), " to select a cell, ", _jsx("span", { className: "font-semibold", children: "Shift+Click" }), " to select a range, and ", _jsx("span", { className: "font-semibold", children: "Ctrl/Cmd+Click" }), " to select multiple cells."] }), _jsxs("li", { children: ["Use ", _jsx("span", { className: "font-semibold", children: "Ctrl/Cmd+C" }), " to copy, ", _jsx("span", { className: "font-semibold", children: "Ctrl/Cmd+V" }), " to paste, and ", _jsx("span", { className: "font-semibold", children: "Delete" }), " key to clear a schedule."] })] })] }), renderHeader(), renderTable()] }));
};
export default SchedulingPanel;
