
import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { createTeam, streamTeamsForAdmin } from '../services/db';
import type { Team } from '../types';
import Spinner from './Spinner';
import UserManagementTable from './UserManagementTable';
import LiveMonitoringDashboard from './LiveMonitoringDashboard';
import TeamStatusView from './TeamStatusView';
import SchedulingPanel from './SchedulingPanel';
import ReportsPanel from './ReportsPanel';
import AdminSettings from './AdminSettings';

const AdminPanel: React.FC = () => {
    const { user } = useAuth();
    const [teams, setTeams] = useState<Team[]>([]);
    const [newTeamName, setNewTeamName] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState('users');
    const [selectedTeamIdForSchedule, setSelectedTeamIdForSchedule] = useState('');
    const [selectedTeamIdForReports, setSelectedTeamIdForReports] = useState('');

    // Use streaming for teams
    useEffect(() => {
        let unsubscribe: (() => void) | undefined;

        if (user) {
            setLoading(true);
            unsubscribe = streamTeamsForAdmin(user.uid, (adminTeams) => {
                setTeams(adminTeams);
                setLoading(false);
                
                // Set defaults if not already set
                if (adminTeams.length > 0) {
                    if (!selectedTeamIdForSchedule) setSelectedTeamIdForSchedule(adminTeams[0].id);
                    if (!selectedTeamIdForReports) setSelectedTeamIdForReports(adminTeams[0].id);
                }
            });
        } else {
            setLoading(false);
        }

        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, [user, selectedTeamIdForSchedule, selectedTeamIdForReports]);

    const handleCreateTeam = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user || !newTeamName.trim()) return;
        setError(null);
        try {
            await createTeam(newTeamName.trim(), user.uid);
            setNewTeamName('');
            // No need to fetchTeams(), the listener will update the list
        } catch (err) {
            setError('Failed to create team.');
        }
    };
    
    const handleCopyToClipboard = (teamId: string) => {
        const inviteLink = `${window.location.origin}${window.location.pathname}#/invite/${teamId}`;
        navigator.clipboard.writeText(inviteLink).then(() => {
            alert('Invite link copied to clipboard!');
        }, (err) => {
            console.error('Could not copy text: ', err);
            alert('Failed to copy link.');
        });
    };

    const TabButton = ({ tabName, title }: { tabName: string, title: string }) => (
        <button
            onClick={() => setActiveTab(tabName)}
            className={`px-4 py-2 text-sm font-medium rounded-md ${activeTab === tabName ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
        >
            {title}
        </button>
    );

    return (
        <div>
            <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-4">Admin Controls</h2>
            
            <TeamStatusView canControlRecording={true} />

            <div className="mb-6 border-b border-gray-200 dark:border-gray-700">
                <nav className="flex flex-wrap gap-2" aria-label="Tabs">
                    <TabButton tabName="users" title="User Management" />
                    <TabButton tabName="teams" title="Team Management" />
                    <TabButton tabName="scheduling" title="Scheduling" />
                    <TabButton tabName="reports" title="Reports" />
                    <TabButton tabName="appSettings" title="Application Settings" />
                    <TabButton tabName="monitoring" title="Detailed Monitoring" />
                </nav>
            </div>

            {error && <p className="text-sm text-red-500 mb-4 p-3 bg-red-100 dark:bg-red-900/50 rounded-md">{error}</p>}

            <div id="tab-content">
                {activeTab === 'monitoring' && <LiveMonitoringDashboard />}
                
                {activeTab === 'users' && <UserManagementTable />}
                
                {activeTab === 'teams' && (
                     <div>
                        <div className="mb-8 p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700">
                            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">Create a New Team</h3>
                            <form onSubmit={handleCreateTeam} className="flex flex-col sm:flex-row gap-2">
                                <input
                                    type="text"
                                    value={newTeamName}
                                    onChange={(e) => setNewTeamName(e.target.value)}
                                    placeholder="New Team Name"
                                    className="flex-grow bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                                    required
                                />
                                <button type="submit" className="text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800">
                                    Create Team
                                </button>
                            </form>
                        </div>

                        <div>
                            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">Your Teams</h3>
                            {loading ? <Spinner /> : (
                                <div className="space-y-3">
                                    {teams.length > 0 ? teams.map(team => (
                                        <div key={team.id} className="p-4 bg-white dark:bg-gray-800/50 rounded-lg shadow-sm border dark:border-gray-700 flex flex-col sm:flex-row justify-between sm:items-center gap-3">
                                            <p className="font-semibold text-gray-800 dark:text-gray-200">{team.name}</p>
                                            <button onClick={() => handleCopyToClipboard(team.id)} className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-500 whitespace-nowrap">
                                                Copy Invite Link
                                            </button>
                                        </div>
                                    )) : (
                                        <p className="text-gray-500 dark:text-gray-400">You haven't created any teams yet.</p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'scheduling' && (
                     <div>
                        {teams.length > 0 ? (
                            <>
                                <div className="mb-4 max-w-sm">
                                    <label htmlFor="team-select-schedule" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Select a Team</label>
                                    <select
                                        id="team-select-schedule"
                                        value={selectedTeamIdForSchedule}
                                        onChange={(e) => setSelectedTeamIdForSchedule(e.target.value)}
                                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
                                    >
                                        {teams.map(team => (
                                            <option key={team.id} value={team.id}>{team.name}</option>
                                        ))}
                                    </select>
                                </div>
                                {selectedTeamIdForSchedule && <SchedulingPanel teamId={selectedTeamIdForSchedule} />}
                            </>
                        ) : (
                             <p className="text-gray-500 dark:text-gray-400">Please create a team first to manage schedules.</p>
                        )}
                    </div>
                )}

                 {activeTab === 'reports' && (
                     <div>
                        {teams.length > 0 ? (
                            <>
                                <div className="mb-4 max-w-sm">
                                    <label htmlFor="team-select-reports" className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Select a Team</label>
                                    <select
                                        id="team-select-reports"
                                        value={selectedTeamIdForReports}
                                        onChange={(e) => setSelectedTeamIdForReports(e.target.value)}
                                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
                                    >
                                        {teams.map(team => (
                                            <option key={team.id} value={team.id}>{team.name}</option>
                                        ))}
                                    </select>
                                </div>
                                {selectedTeamIdForReports && <ReportsPanel teamId={selectedTeamIdForReports} />}
                            </>
                        ) : (
                             <p className="text-gray-500 dark:text-gray-400">Please create a team first to generate reports.</p>
                        )}
                    </div>
                )}

                {activeTab === 'appSettings' && <AdminSettings />}

            </div>
        </div>
    );
};

export default AdminPanel;
