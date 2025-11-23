import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import LiveMonitoringDashboard from './LiveMonitoringDashboard';
import SchedulingPanel from './SchedulingPanel';
import { useAuth } from '../hooks/useAuth';
import TeamStatusView from './TeamStatusView';
import ReportsPanel from './ReportsPanel';
import { getTeamById } from '../services/db';
const ManagerPanel = () => {
    const { userData } = useAuth();
    const [activeTab, setActiveTab] = useState('scheduling');
    // Logic for multiple teams
    const [availableTeams, setAvailableTeams] = useState([]);
    const [currentTeamId, setCurrentTeamId] = useState('');
    const [loadingTeams, setLoadingTeams] = useState(true);
    useEffect(() => {
        const fetchTeams = async () => {
            if (!userData)
                return;
            const ids = userData.teamIds || (userData.teamId ? [userData.teamId] : []);
            if (ids.length > 0) {
                try {
                    // Fetch details for all teams to display names
                    const promises = ids.map((id) => getTeamById(id));
                    const results = await Promise.all(promises);
                    const validTeams = results.filter((t) => t !== null);
                    setAvailableTeams(validTeams);
                    if (validTeams.length > 0) {
                        setCurrentTeamId(validTeams[0].id);
                    }
                }
                catch (e) {
                    console.error("Error fetching manager teams", e);
                }
            }
            setLoadingTeams(false);
        };
        fetchTeams();
    }, [userData]);
    const TabButton = ({ tabName, title }) => (_jsx("button", { onClick: () => setActiveTab(tabName), className: `px-4 py-2 text-sm font-medium rounded-md ${activeTab === tabName ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`, children: title }));
    if (loadingTeams) {
        return _jsx("div", { className: "p-4 text-center", children: "Loading team data..." });
    }
    if (availableTeams.length === 0) {
        return _jsx("p", { className: "text-red-500 p-4", children: "Error: You are not assigned to any team." });
    }
    return (_jsxs("div", { children: [_jsx("h2", { className: "text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-6", children: "Manager Dashboard" }), _jsx("div", { className: "mb-8 space-y-6", children: availableTeams.map(team => (_jsxs("div", { className: "flex flex-col gap-2", children: [_jsxs("div", { className: "flex items-center gap-2 px-1", children: [_jsx("h3", { className: "text-lg font-bold text-gray-700 dark:text-gray-300", children: team.name }), _jsx("span", { className: "text-xs font-normal text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border dark:border-gray-700", children: "Live Status" })] }), _jsx(TeamStatusView, { teamId: team.id, canControlRecording: true, isMinimizable: true })] }, team.id))) }), _jsx("div", { className: "border-t border-gray-300 dark:border-gray-600 my-8" }), _jsxs("div", { className: "flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6", children: [_jsx("h3", { className: "text-xl font-semibold text-gray-800 dark:text-gray-200", children: "Team Management" }), availableTeams.length > 1 && (_jsxs("div", { className: "flex items-center gap-2 bg-white dark:bg-gray-800 p-2 rounded-lg shadow-sm border dark:border-gray-700", children: [_jsx("span", { className: "text-sm font-medium text-gray-600 dark:text-gray-300", children: "Select Team:" }), _jsx("select", { value: currentTeamId, onChange: (e) => setCurrentTeamId(e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-1.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", children: availableTeams.map(team => (_jsx("option", { value: team.id, children: team.name }, team.id))) })] })), availableTeams.length === 1 && (_jsxs("span", { className: "text-sm text-gray-500 dark:text-gray-400 border px-3 py-1 rounded-full", children: ["Managing: ", _jsx("span", { className: "font-semibold text-gray-700 dark:text-gray-200", children: availableTeams[0].name })] }))] }), _jsx("div", { className: "mb-6 border-b border-gray-200 dark:border-gray-700", children: _jsxs("nav", { className: "flex flex-wrap gap-2", "aria-label": "Tabs", children: [_jsx(TabButton, { tabName: "scheduling", title: "Team Schedule" }), _jsx(TabButton, { tabName: "reports", title: "Reports" }), _jsx(TabButton, { tabName: "monitoring", title: "Detailed Agent Monitoring" })] }) }), _jsx("div", { id: "tab-content", children: currentTeamId ? (_jsxs(_Fragment, { children: [activeTab === 'monitoring' && _jsx(LiveMonitoringDashboard, { teamId: currentTeamId }), activeTab === 'scheduling' && _jsx(SchedulingPanel, { teamId: currentTeamId }), activeTab === 'reports' && _jsx(ReportsPanel, { teamId: currentTeamId })] })) : (_jsx("p", { className: "text-gray-500", children: "Please select a team to manage." })) })] }));
};
export default ManagerPanel;
