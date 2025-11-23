import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { streamAllUsers, streamTeamsForAdmin, updateUser } from '../services/db';
import Spinner from './Spinner';
import { useAuth } from '../hooks/useAuth';
const UserManagementTable = () => {
    const { user: adminUser } = useAuth();
    const [users, setUsers] = useState([]);
    const [teams, setTeams] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // State for Team Management Modal
    const [editingUser, setEditingUser] = useState(null);
    const [tempTeamIds, setTempTeamIds] = useState(new Set());
    useEffect(() => {
        if (!adminUser)
            return;
        setLoading(true);
        // Subscribe to Users
        const unsubscribeUsers = streamAllUsers((usersData) => {
            setUsers(usersData);
        });
        // Subscribe to Teams (to map team IDs to names)
        const unsubscribeTeams = streamTeamsForAdmin(adminUser.uid, (teamsData) => {
            setTeams(teamsData);
            setLoading(false);
        });
        return () => {
            unsubscribeUsers();
            unsubscribeTeams();
        };
    }, [adminUser]);
    const handleRoleChange = async (uid, newRole) => {
        const originalUsers = [...users];
        setUsers(users.map(u => u.uid === uid ? { ...u, role: newRole } : u));
        try {
            await updateUser(uid, { role: newRole });
        }
        catch (err) {
            setError(`Failed to update role for user ${uid}.`);
            setUsers(originalUsers);
        }
    };
    const getTeamNames = (user) => {
        const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
        if (ids.length === 0)
            return 'None';
        return ids.map((id) => teams.find(t => t.id === id)?.name || 'Unknown').join(', ');
    };
    const openTeamModal = (user) => {
        const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
        setTempTeamIds(new Set(ids));
        setEditingUser(user);
    };
    const toggleTeamSelection = (teamId) => {
        const newSet = new Set(tempTeamIds);
        if (newSet.has(teamId)) {
            newSet.delete(teamId);
        }
        else {
            newSet.add(teamId);
        }
        setTempTeamIds(newSet);
    };
    const saveTeamChanges = async () => {
        if (!editingUser)
            return;
        const newIds = Array.from(tempTeamIds);
        const originalUsers = [...users];
        // Optimistic update
        setUsers(users.map(u => u.uid === editingUser.uid ? { ...u, teamIds: newIds, teamId: newIds[0] || undefined } : u));
        try {
            await updateUser(editingUser.uid, {
                teamIds: newIds,
                teamId: (newIds[0] || null) // Cast to any to allow null for legacy/firestore compatibility
            });
            setEditingUser(null);
        }
        catch (err) {
            setError("Failed to update user teams.");
            setUsers(originalUsers);
        }
    };
    if (loading && users.length === 0) {
        return _jsx("div", { className: "flex justify-center items-center p-8", children: _jsx(Spinner, {}) });
    }
    return (_jsxs(_Fragment, { children: [error && _jsx("p", { className: "text-center text-red-500 dark:text-red-400 mb-4", children: error }), _jsx("div", { className: "overflow-x-auto relative shadow-md sm:rounded-lg", children: _jsxs("table", { className: "w-full text-sm text-left text-gray-500 dark:text-gray-400", children: [_jsx("thead", { className: "text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400", children: _jsxs("tr", { children: [_jsx("th", { scope: "col", className: "py-3 px-6", children: "Name" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Email" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Teams" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Role" }), _jsx("th", { scope: "col", className: "py-3 px-6", children: "Actions" })] }) }), _jsx("tbody", { children: users.map(user => (_jsxs("tr", { className: "bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600", children: [_jsx("td", { className: "py-4 px-6 font-medium text-gray-900 whitespace-nowrap dark:text-white", children: user.displayName || 'No Name' }), _jsx("td", { className: "py-4 px-6", children: user.email }), _jsx("td", { className: "py-4 px-6 max-w-xs truncate", title: getTeamNames(user), children: getTeamNames(user) }), _jsx("td", { className: "py-4 px-6", children: user.role === 'admin' ? (_jsx("span", { className: "capitalize", children: user.role })) : (_jsxs("select", { value: user.role, onChange: (e) => handleRoleChange(user.uid, e.target.value), className: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white", children: [_jsx("option", { value: "agent", children: "Agent" }), _jsx("option", { value: "manager", children: "Manager" })] })) }), _jsx("td", { className: "py-4 px-6", children: _jsx("button", { onClick: () => openTeamModal(user), className: "font-medium text-blue-600 dark:text-blue-500 hover:underline", children: "Manage Teams" }) })] }, user.uid))) })] }) }), editingUser && (_jsx("div", { className: "fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4", children: _jsxs("div", { className: "bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6", children: [_jsxs("h3", { className: "text-xl font-semibold text-gray-900 dark:text-white mb-4", children: ["Manage Teams for ", editingUser.displayName] }), _jsx("div", { className: "space-y-3 max-h-60 overflow-y-auto mb-6", children: teams.length > 0 ? teams.map(team => (_jsxs("div", { className: "flex items-center", children: [_jsx("input", { id: `team-${team.id}`, type: "checkbox", checked: tempTeamIds.has(team.id), onChange: () => toggleTeamSelection(team.id), className: "w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600" }), _jsx("label", { htmlFor: `team-${team.id}`, className: "ml-2 text-sm font-medium text-gray-900 dark:text-gray-300", children: team.name })] }, team.id))) : (_jsx("p", { className: "text-gray-500", children: "No teams available." })) }), _jsxs("div", { className: "flex justify-end gap-3", children: [_jsx("button", { onClick: () => setEditingUser(null), className: "px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600", children: "Cancel" }), _jsx("button", { onClick: saveTeamChanges, className: "px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800", children: "Save Changes" })] })] }) }))] }));
};
export default UserManagementTable;
