
import React, { useState, useEffect, useMemo } from 'react';
import { streamAllUsers, streamTeamsForAdmin, updateUser, deleteUserDocument } from '../services/db';
import type { UserData, Team, Role } from '../types';
import Spinner from './Spinner';
import { useAuth } from '../hooks/useAuth';
import { getDisplayRole, getPrimaryRole, getUserRoles, hasRole } from '../utils/roles';

type SortField = 'name' | 'role' | 'team';
type SortDirection = 'asc' | 'desc';

const UserManagementTable: React.FC = () => {
    const { user: adminUser } = useAuth();
    const [users, setUsers] = useState<UserData[]>([]);
    const [teams, setTeams] = useState<Team[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // State for Team Management Modal
    const [editingUser, setEditingUser] = useState<UserData | null>(null);
    const [tempTeamIds, setTempTeamIds] = useState<Set<string>>(new Set());
    const [editingRolesUser, setEditingRolesUser] = useState<UserData | null>(null);
    const [tempRoles, setTempRoles] = useState<Set<Role>>(new Set());

    // Filter and Sort State
    const [filterTeam, setFilterTeam] = useState<string>('all');
    const [filterRole, setFilterRole] = useState<string>('all');
    const [searchName, setSearchName] = useState<string>('');
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

    useEffect(() => {
        if (!adminUser) return;

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

    const handleRoleChange = async (uid: string, newRoles: Role[]) => {
        const uniqueRoles = Array.from(new Set(newRoles));
        if (uniqueRoles.length === 0) {
            setError('At least one role is required.');
            return false;
        }
        const simulatedUsers = users.map((u) => (
            u.uid === uid
                ? { ...u, roles: uniqueRoles, role: getPrimaryRole({ roles: uniqueRoles }) || 'agent' }
                : u
        ));
        const adminCountAfterChange = simulatedUsers.filter((u) => hasRole(u, 'admin')).length;
        if (adminCountAfterChange === 0) {
            setError('At least one admin is required. Add admin role to another user before removing it.');
            return false;
        }
        const newPrimaryRole = getPrimaryRole({ roles: uniqueRoles }) || 'agent';
        const originalUsers = [...users];
        setUsers(users.map(u => u.uid === uid ? { ...u, role: newPrimaryRole, roles: uniqueRoles } : u));
        try {
            await updateUser(uid, { role: newPrimaryRole, roles: uniqueRoles });
            return true;
        } catch (err) {
            setError(`Failed to update role for user ${uid}.`);
            setUsers(originalUsers);
            return false;
        }
    };

    const openRolesModal = (user: UserData) => {
        setTempRoles(new Set(getUserRoles(user)));
        setEditingRolesUser(user);
    };

    const toggleRoleSelection = (role: Role) => {
        const newSet = new Set(tempRoles);
        if (newSet.has(role)) {
            newSet.delete(role);
        } else {
            newSet.add(role);
        }
        setTempRoles(newSet);
    };

    const saveRoleChanges = async () => {
        if (!editingRolesUser) return;
        const success = await handleRoleChange(editingRolesUser.uid, Array.from(tempRoles));
        if (success) {
            setEditingRolesUser(null);
        }
    };

    const handleDeleteUser = async (target: UserData) => {
        if (!target?.uid) return;
        if (target.uid === adminUser?.uid) {
            setError('You cannot delete your own account from this panel.');
            return;
        }
        if (hasRole(target, 'admin')) {
            setError('Admin users cannot be deleted from this panel.');
            return;
        }
        const confirmed = window.confirm(`Delete user "${target.displayName || target.email || target.uid}"? This removes the user profile from the dashboard.`);
        if (!confirmed) return;

        const originalUsers = [...users];
        setUsers(users.filter((u) => u.uid !== target.uid));
        try {
            await deleteUserDocument(target.uid);
        } catch (err) {
            setError(`Failed to delete user ${target.uid}.`);
            setUsers(originalUsers);
        }
    };

    const getTeamNames = (user: UserData) => {
        const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
        if (ids.length === 0) return 'None';

        return ids.map((id: string) => teams.find(t => t.id === id)?.name || 'Unknown').join(', ');
    };

    const getFirstTeamName = (user: UserData) => {
        const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
        if (ids.length === 0) return '';
        return teams.find(t => t.id === ids[0])?.name || '';
    };

    const openTeamModal = (user: UserData) => {
        const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
        setTempTeamIds(new Set(ids));
        setEditingUser(user);
    };

    const toggleTeamSelection = (teamId: string) => {
        const newSet = new Set(tempTeamIds);
        if (newSet.has(teamId)) {
            newSet.delete(teamId);
        } else {
            newSet.add(teamId);
        }
        setTempTeamIds(newSet);
    };

    const saveTeamChanges = async () => {
        if (!editingUser) return;
        const newIds: string[] = Array.from(tempTeamIds);
        const originalUsers = [...users];

        // Optimistic update
        setUsers(users.map(u => u.uid === editingUser.uid ? { ...u, teamIds: newIds, teamId: newIds[0] || undefined } : u));

        try {
            await updateUser(editingUser.uid, {
                teamIds: newIds,
                teamId: (newIds[0] || null) as any // Cast to any to allow null for legacy/firestore compatibility
            });
            setEditingUser(null);
        } catch (err) {
            setError("Failed to update user teams.");
            setUsers(originalUsers);
        }
    };

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('asc');
        }
    };

    const getSortIndicator = (field: SortField) => {
        if (sortField !== field) return null;
        return sortDirection === 'asc' ? ' ↑' : ' ↓';
    };

    // Filtered and sorted users
    const filteredAndSortedUsers = useMemo(() => {
        let result = [...users];

        // Filter by team
        if (filterTeam !== 'all') {
            result = result.filter(user => {
                const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
                return ids.includes(filterTeam);
            });
        }

        // Filter by role
        if (filterRole !== 'all') {
            result = result.filter(user => hasRole(user, filterRole as Role));
        }

        // Filter by name search
        if (searchName.trim()) {
            const search = searchName.toLowerCase().trim();
            result = result.filter(user =>
                (user.displayName || '').toLowerCase().includes(search) ||
                (user.email || '').toLowerCase().includes(search)
            );
        }

        // Sort
        result.sort((a, b) => {
            let comparison = 0;
            switch (sortField) {
                case 'name':
                    comparison = (a.displayName || '').localeCompare(b.displayName || '');
                    break;
                case 'role':
                    comparison = getDisplayRole(a).localeCompare(getDisplayRole(b));
                    break;
                case 'team':
                    comparison = getFirstTeamName(a).localeCompare(getFirstTeamName(b));
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });

        return result;
    }, [users, filterTeam, filterRole, searchName, sortField, sortDirection, teams]);

    if (loading && users.length === 0) {
        return <div className="flex justify-center items-center p-8"><Spinner /></div>;
    }

    return (
        <>
            {error && <p className="text-center text-red-500 dark:text-red-400 mb-4">{error}</p>}

            {/* Filter Bar */}
            <div className="mb-4 p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700 flex flex-wrap gap-4 items-end">
                <div className="flex-1 min-w-[200px]">
                    <label className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">Search Name/Email</label>
                    <input
                        type="text"
                        value={searchName}
                        onChange={(e) => setSearchName(e.target.value)}
                        placeholder="Search..."
                        className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
                    />
                </div>
                <div className="min-w-[150px]">
                    <label className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">Team</label>
                    <select
                        value={filterTeam}
                        onChange={(e) => setFilterTeam(e.target.value)}
                        className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    >
                        <option value="all">All Teams</option>
                        {teams.map(team => (
                            <option key={team.id} value={team.id}>{team.name}</option>
                        ))}
                    </select>
                </div>
                <div className="min-w-[150px]">
                    <label className="block mb-1 text-sm font-medium text-gray-700 dark:text-gray-300">Role</label>
                    <select
                        value={filterRole}
                        onChange={(e) => setFilterRole(e.target.value)}
                        className="bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    >
                        <option value="all">All Roles</option>
                        <option value="agent">Agent</option>
                        <option value="manager">Manager</option>
                        <option value="admin">Admin</option>
                    </select>
                </div>
                {(filterTeam !== 'all' || filterRole !== 'all' || searchName) && (
                    <button
                        onClick={() => { setFilterTeam('all'); setFilterRole('all'); setSearchName(''); }}
                        className="px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                    >
                        Clear Filters
                    </button>
                )}
            </div>

            <div className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                Showing {filteredAndSortedUsers.length} of {users.length} users
            </div>

            <div className="overflow-x-auto relative shadow-md sm:rounded-lg">
                <table className="w-full text-sm text-left text-gray-500 dark:text-gray-400">
                    <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
                        <tr>
                            <th
                                scope="col"
                                className="py-3 px-6 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                                onClick={() => handleSort('name')}
                            >
                                Name{getSortIndicator('name')}
                            </th>
                            <th scope="col" className="py-3 px-6">Email</th>
                            <th
                                scope="col"
                                className="py-3 px-6 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                                onClick={() => handleSort('team')}
                            >
                                Teams{getSortIndicator('team')}
                            </th>
                            <th
                                scope="col"
                                className="py-3 px-6 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 select-none"
                                onClick={() => handleSort('role')}
                            >
                                Role{getSortIndicator('role')}
                            </th>
                            <th scope="col" className="py-3 px-6">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredAndSortedUsers.map(user => (
                            <tr key={user.uid} className="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600">
                                <td className="py-4 px-6 font-medium text-gray-900 whitespace-nowrap dark:text-white">{user.displayName || 'No Name'}</td>
                                <td className="py-4 px-6">{user.email}</td>
                                <td className="py-4 px-6 max-w-xs truncate" title={getTeamNames(user)}>
                                    {getTeamNames(user)}
                                </td>
                                <td className="py-4 px-6">
                                    <span className="block text-sm text-gray-700 dark:text-gray-300">
                                        {getDisplayRole(user)}
                                    </span>
                                </td>
                                <td className="py-4 px-6">
                                    <div className="flex flex-col gap-2">
                                        <button
                                            onClick={() => openRolesModal(user)}
                                            className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline text-left"
                                        >
                                            Manage Roles
                                        </button>
                                        <button
                                            onClick={() => openTeamModal(user)}
                                            className="font-medium text-blue-600 dark:text-blue-500 hover:underline text-left"
                                        >
                                            Manage Teams
                                        </button>
                                        {!hasRole(user, 'admin') && (
                                            <button
                                                onClick={() => handleDeleteUser(user)}
                                                className="font-medium text-red-600 dark:text-red-400 hover:underline text-left"
                                            >
                                                Delete User
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                        {filteredAndSortedUsers.length === 0 && (
                            <tr>
                                <td colSpan={5} className="py-8 px-6 text-center text-gray-500 dark:text-gray-400">
                                    No users match the current filters.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Team Management Modal */}
            {editingUser && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                            Manage Teams for {editingUser.displayName}
                        </h3>
                        {error && (
                            <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>
                        )}
                        <div className="space-y-3 max-h-60 overflow-y-auto mb-6">
                            {teams.length > 0 ? teams.map(team => (
                                <div key={team.id} className="flex items-center">
                                    <input
                                        id={`team-${team.id}`}
                                        type="checkbox"
                                        checked={tempTeamIds.has(team.id)}
                                        onChange={() => toggleTeamSelection(team.id)}
                                        className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                                    />
                                    <label htmlFor={`team-${team.id}`} className="ml-2 text-sm font-medium text-gray-900 dark:text-gray-300">
                                        {team.name}
                                    </label>
                                </div>
                            )) : (
                                <p className="text-gray-500">No teams available.</p>
                            )}
                        </div>
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setEditingUser(null)}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={saveTeamChanges}
                                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
                            >
                                Save Changes
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Role Management Modal */}
            {editingRolesUser && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">
                            Manage Roles for {editingRolesUser.displayName}
                        </h3>
                        {error && (
                            <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>
                        )}
                        <div className="space-y-3 mb-6">
                            {(['agent', 'manager', 'admin'] as Role[]).map((role) => (
                                <div key={role} className="flex items-center">
                                    <input
                                        id={`role-${editingRolesUser.uid}-${role}`}
                                        type="checkbox"
                                        checked={tempRoles.has(role)}
                                        onChange={() => toggleRoleSelection(role)}
                                        className="w-4 h-4 text-indigo-600 bg-gray-100 border-gray-300 rounded focus:ring-indigo-500 dark:focus:ring-indigo-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                                    />
                                    <label htmlFor={`role-${editingRolesUser.uid}-${role}`} className="ml-2 text-sm font-medium text-gray-900 dark:text-gray-300 capitalize">
                                        {role}
                                    </label>
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setEditingRolesUser(null)}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={saveRoleChanges}
                                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-300 dark:bg-indigo-600 dark:hover:bg-indigo-700 dark:focus:ring-indigo-800"
                            >
                                Save Changes
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

export default UserManagementTable;

