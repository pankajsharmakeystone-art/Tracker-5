import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { createTeam, streamTeamsForAdmin, updateTeamSettings } from '../services/db';
import Spinner from './Spinner';
import UserManagementTable from './UserManagementTable';
import LiveMonitoringDashboard from './LiveMonitoringDashboard';
import TeamStatusView from './TeamStatusView';
import SchedulingPanel from './SchedulingPanel';
import ReportsPanel from './ReportsPanel';
import AdminSettings from './AdminSettings';
const AdminPanel = () => {
    const { user } = useAuth();
    const [teams, setTeams] = useState([]);
    const [newTeamName, setNewTeamName] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeTab, setActiveTab] = useState('users');
    const [showLiveStatus, setShowLiveStatus] = useState(true);
    const [selectedTeamIdForSchedule, setSelectedTeamIdForSchedule] = useState('');
    const [selectedTeamIdForReports, setSelectedTeamIdForReports] = useState('');
    // Use streaming for teams
    useEffect(() => {
        let unsubscribe;
        if (user) {
            setLoading(true);
            unsubscribe = streamTeamsForAdmin(user.uid, (adminTeams) => {
                setTeams(adminTeams);
                setLoading(false);
                // Set defaults if not already set
                if (adminTeams.length > 0) {
                    if (!selectedTeamIdForSchedule)
                        setSelectedTeamIdForSchedule(adminTeams[0].id);
                    if (!selectedTeamIdForReports)
                        setSelectedTeamIdForReports(adminTeams[0].id);
                    if (adminTeams[0].settings) {
                        setShowLiveStatus(adminTeams[0].settings.showLiveTeamStatus ?? true);
                    }
                }
            });
        }
        else {
            setLoading(false);
        }
        return () => {
            if (unsubscribe)
                unsubscribe();
        };
    }, [user, selectedTeamIdForSchedule, selectedTeamIdForReports]);
    const handleCreateTeam = async (e) => {
        e.preventDefault();
        if (!user || !newTeamName.trim())
            return;
        setError(null);
        try {
            await createTeam(newTeamName.trim(), user.uid);
            setNewTeamName('');
            // No need to fetchTeams(), the listener will update the list
        }
        catch (err) {
            setError('Failed to create team.');
        }
    };
    const handleCopyToClipboard = (teamId) => {
        const inviteLink = `${window.location.origin}${window.location.pathname}#/invite/${teamId}`;
        navigator.clipboard.writeText(inviteLink).then(() => {
            alert('Invite link copied to clipboard!');
        }, (err) => {
            console.error('Could not copy text: ', err);
            alert('Failed to copy link.');
        });
    };
    const handleSettingsUpdate = async (e) => {
        e.preventDefault();
        setError(null);
        try {
            const settingsToUpdate = {
                showLiveTeamStatus: showLiveStatus
            };
            // Update settings for all teams owned by this admin
            const promises = teams.map(team => updateTeamSettings(team.id, settingsToUpdate));
            await Promise.all(promises);
            alert('Settings updated successfully!');
        }
        catch (err) {
            setError("Failed to update settings.");
        }
    };
    const TabButton = ({ tabName, title }) => (_jsx("button", { onClick: () => setActiveTab(tabName), className: `px-4 py-2 text-sm font-medium rounded-md ${activeTab === tabName ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`, children: title }));
    return (_jsxs("div", { children: [_jsx("h2", { className: "text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-4", children: "Admin Controls" }), _jsx(TeamStatusView, { canControlRecording: true }), _jsx("div", { className: "mb-6 border-b border-gray-200 dark:border-gray-700", children: _jsxs("nav", { className: "flex flex-wrap gap-2", "aria-label": "Tabs", children: [_jsx(TabButton, { tabName: "users", title: "User Management" }), _jsx(TabButton, { tabName: "teams", title: "Team Management" }), _jsx(TabButton, { tabName: "scheduling", title: "Scheduling" }), _jsx(TabButton, { tabName: "reports", title: "Reports" }), _jsx(TabButton, { tabName: "teamSettings", title: "Team Settings" }), _jsx(TabButton, { tabName: "appSettings", title: "Application Settings" }), _jsx(TabButton, { tabName: "monitoring", title: "Detailed Monitoring" })] }) }), error && _jsx("p", { className: "text-sm text-red-500 mb-4 p-3 bg-red-100 dark:bg-red-900/50 rounded-md", children: error }), _jsxs("div", { id: "tab-content", children: [activeTab === 'monitoring' && _jsx(LiveMonitoringDashboard, {}), activeTab === 'users' && _jsx(UserManagementTable, {}), activeTab === 'teams' && (_jsxs("div", { children: [_jsxs("div", { className: "mb-8 p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700", children: [_jsx("h3", { className: "text-lg font-medium text-gray-900 dark:text-white mb-2", children: "Create a New Team" }), _jsxs("form", { onSubmit: handleCreateTeam, className: "flex flex-col sm:flex-row gap-2", children: [_jsx("input", { type: "text", value: newTeamName, onChange: (e) => setNewTeamName(e.target.value), placeholder: "New Team Name", className: "flex-grow bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", required: true }), _jsx("button", { type: "submit", className: "text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800", children: "Create Team" })] })] }), _jsxs("div", { children: [_jsx("h3", { className: "text-lg font-medium text-gray-900 dark:text-white mb-3", children: "Your Teams" }), loading ? _jsx(Spinner, {}) : (_jsx("div", { className: "space-y-3", children: teams.length > 0 ? teams.map(team => (_jsxs("div", { className: "p-4 bg-white dark:bg-gray-800/50 rounded-lg shadow-sm border dark:border-gray-700 flex flex-col sm:flex-row justify-between sm:items-center gap-3", children: [_jsx("p", { className: "font-semibold text-gray-800 dark:text-gray-200", children: team.name }), _jsx("button", { onClick: () => handleCopyToClipboard(team.id), className: "text-sm font-medium text-blue-600 hover:underline dark:text-blue-500 whitespace-nowrap", children: "Copy Invite Link" })] }, team.id))) : (_jsx("p", { className: "text-gray-500 dark:text-gray-400", children: "You haven't created any teams yet." })) }))] })] })), activeTab === 'scheduling' && (_jsx("div", { children: teams.length > 0 ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-4 max-w-sm", children: [_jsx("label", { htmlFor: "team-select-schedule", className: "block mb-2 text-sm font-medium text-gray-900 dark:text-white", children: "Select a Team" }), _jsx("select", { id: "team-select-schedule", value: selectedTeamIdForSchedule, onChange: (e) => setSelectedTeamIdForSchedule(e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500", children: teams.map(team => (_jsx("option", { value: team.id, children: team.name }, team.id))) })] }), selectedTeamIdForSchedule && _jsx(SchedulingPanel, { teamId: selectedTeamIdForSchedule })] })) : (_jsx("p", { className: "text-gray-500 dark:text-gray-400", children: "Please create a team first to manage schedules." })) })), activeTab === 'reports' && (_jsx("div", { children: teams.length > 0 ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-4 max-w-sm", children: [_jsx("label", { htmlFor: "team-select-reports", className: "block mb-2 text-sm font-medium text-gray-900 dark:text-white", children: "Select a Team" }), _jsx("select", { id: "team-select-reports", value: selectedTeamIdForReports, onChange: (e) => setSelectedTeamIdForReports(e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500", children: teams.map(team => (_jsx("option", { value: team.id, children: team.name }, team.id))) })] }), selectedTeamIdForReports && _jsx(ReportsPanel, { teamId: selectedTeamIdForReports })] })) : (_jsx("p", { className: "text-gray-500 dark:text-gray-400", children: "Please create a team first to generate reports." })) })), activeTab === 'teamSettings' && (_jsxs("div", { className: "p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700", children: [_jsx("h3", { className: "text-lg font-medium text-gray-900 dark:text-white mb-4", children: "General Team Settings" }), _jsxs("form", { onSubmit: handleSettingsUpdate, children: [_jsxs("div", { className: "flex items-center mb-4", children: [_jsx("input", { id: "showLiveTeamStatus", type: "checkbox", checked: showLiveStatus, onChange: (e) => setShowLiveStatus(e.target.checked), className: "w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600" }), _jsx("label", { htmlFor: "showLiveTeamStatus", className: "ml-2 text-sm font-medium text-gray-900 dark:text-gray-300", children: "Show \"Live Team Status\" widget to agents" })] }), _jsx("button", { type: "submit", className: "text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800", children: "Update All Teams" })] })] })), activeTab === 'appSettings' && _jsx(AdminSettings, {})] })] }));
};
export default AdminPanel;
