import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback, useMemo } from 'react';
import { getScheduleForMonth } from '../services/db';
import Spinner from './Spinner';
const AgentScheduleView = ({ userId, teamId }) => {
    const [schedule, setSchedule] = useState(null);
    const [currentDate, setCurrentDate] = useState(new Date());
    const [loading, setLoading] = useState(true);
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const monthlySchedule = await getScheduleForMonth(teamId, year, month + 1);
            const userShifts = monthlySchedule[userId] || {};
            setSchedule({ userId, shifts: userShifts });
        }
        catch (error) {
            console.error("Failed to fetch schedule:", error);
            setSchedule({ userId, shifts: {} });
        }
        finally {
            setLoading(false);
        }
    }, [userId, teamId, year, month]);
    useEffect(() => {
        fetchData();
    }, [fetchData]);
    const calendarGrid = useMemo(() => {
        const firstDayOfMonth = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const grid = [];
        // Add empty cells for days before the 1st
        for (let i = 0; i < firstDayOfMonth; i++) {
            grid.push(null);
        }
        // Add days of the month
        for (let i = 1; i <= daysInMonth; i++) {
            grid.push(i);
        }
        return grid;
    }, [year, month]);
    const renderHeader = () => {
        const monthName = currentDate.toLocaleString('default', { month: 'long' });
        return (_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("button", { onClick: () => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() - 1))), className: "px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600", "aria-label": "Previous month", children: "<" }), _jsxs("h3", { className: "text-xl font-semibold text-gray-800 dark:text-white", children: [monthName, " ", year] }), _jsx("button", { onClick: () => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() + 1))), className: "px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600", "aria-label": "Next month", children: ">" })] }));
    };
    if (loading) {
        return _jsx("div", { className: "flex justify-center items-center p-8", children: _jsx(Spinner, {}) });
    }
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
    return (_jsxs("div", { children: [renderHeader(), _jsxs("div", { className: "grid grid-cols-7 gap-1 text-center text-sm", children: [['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (_jsx("div", { className: "font-bold text-gray-600 dark:text-gray-400 py-2", children: day }, day))), calendarGrid.map((day, index) => {
                        if (!day) {
                            return _jsx("div", { className: "border rounded-lg dark:border-gray-700 min-h-[100px]" }, `empty-${index}`);
                        }
                        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                        const shift = schedule?.shifts ? schedule.shifts[dateStr] : null;
                        const isToday = isCurrentMonth && day === today.getDate();
                        return (_jsxs("div", { className: `border rounded-lg p-2 flex flex-col min-h-[100px] ${isToday ? 'bg-blue-100 dark:bg-blue-900/50 border-blue-400' : 'bg-gray-50 dark:bg-gray-800/50 dark:border-gray-700'}`, children: [_jsx("div", { className: `font-bold ${isToday ? 'text-blue-600 dark:text-blue-300' : 'text-gray-900 dark:text-white'}`, children: day }), _jsx("div", { className: "mt-1 text-xs flex-grow flex items-center justify-center", children: shift ? (shift === 'OFF' ? (_jsx("span", { className: "font-semibold text-red-500", children: "OFF" })) : shift === 'L' ? (_jsx("span", { className: "font-semibold text-purple-500", children: "LEAVE" })) : (_jsxs("span", { className: "font-mono text-gray-700 dark:text-gray-300", children: [shift.startTime, " - ", shift.endTime] }))) : (_jsx("span", { className: "text-gray-400", children: "--" })) })] }, day));
                    })] })] }));
};
export default AgentScheduleView;
