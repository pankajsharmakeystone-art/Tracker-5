
import React, { useState, useEffect } from 'react';
import { streamAllUsers, streamTeamsForAdmin, updateUser } from '../services/db';
import type { UserData, Team, Role } from '../types';
import Spinner from './Spinner';
import { useAuth } from '../hooks/useAuth';

const UserManagementTable: React.FC = () => {
    const { user: adminUser } = useAuth();
    const [users, setUsers] = useState<UserData[]>([]);
    const [teams, setTeams] = useState<Team[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    
    // State for Team Management Modal
    const [editingUser, setEditingUser] = useState<UserData | null>(null);
    const [tempTeamIds, setTempTeamIds] = useState<Set<string>>(new Set());

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

    const handleRoleChange = async (uid: string, newRole: Role) => {
        const originalUsers = [...users];
        setUsers(users.map(u => u.uid === uid ? { ...u, role: newRole } : u));
        try {
            await updateUser(uid, { role: newRole });
        } catch (err) {
            setError(`Failed to update role for user ${uid}.`);
            setUsers(originalUsers);
        }
    };
    
    const getTeamNames = (user: UserData) => {
        const ids = user.teamIds || (user.teamId ? [user.teamId] : []);
        if (ids.length === 0) return 'None';
        
        return ids.map((id: string) => teams.find(t => t.id === id)?.name || 'Unknown').join(', ');
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

    if (loading && users.length === 0) {
        return <div className="flex justify-center items-center p-8"><Spinner /></div>;
    }

    return (
        <>
            {error && <p className="text-center text-red-500 dark:text-red-400 mb-4">{error}</p>}
            
            <div className="overflow-x-auto relative shadow-md sm:rounded-lg">
                <table className="w-full text-sm text-left text-gray-500 dark:text-gray-400">
                    <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400">
                        <tr>
                            <th scope="col" className="py-3 px-6">Name</th>
                            <th scope="col" className="py-3 px-6">Email</th>
                            <th scope="col" className="py-3 px-6">Teams</th>
                            <th scope="col" className="py-3 px-6">Role</th>
                            <th scope="col" className="py-3 px-6">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(user => (
                            <tr key={user.uid} className="bg-white border-b dark:bg-gray-800 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600">
                                <td className="py-4 px-6 font-medium text-gray-900 whitespace-nowrap dark:text-white">{user.displayName || 'No Name'}</td>
                                <td className="py-4 px-6">{user.email}</td>
                                <td className="py-4 px-6 max-w-xs truncate" title={getTeamNames(user)}>
                                    {getTeamNames(user)}
                                </td>
                                <td className="py-4 px-6">
                                    {user.role === 'admin' ? (
                                        <span className="capitalize">{user.role}</span>
                                    ) : (
                                        <select
                                            value={user.role}
                                            onChange={(e) => handleRoleChange(user.uid, e.target.value as Role)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                                        >
                                            <option value="agent">Agent</option>
                                            <option value="manager">Manager</option>
                                        </select>
                                    )}
                                </td>
                                <td className="py-4 px-6">
                                    <button 
                                        onClick={() => openTeamModal(user)}
                                        className="font-medium text-blue-600 dark:text-blue-500 hover:underline"
                                    >
                                        Manage Teams
                                    </button>
                                </td>
                            </tr>
                        ))}
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
        </>
    );
};

export default UserManagementTable;
