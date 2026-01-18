
import React, { useState, useEffect } from 'react';
import LiveMonitoringDashboard from './LiveMonitoringDashboard';
import SchedulingPanel from './SchedulingPanel';
import { useAuth } from '../hooks/useAuth';
import TeamStatusView from './TeamStatusView';
import ReportsPanel from './ReportsPanel';
import RecordingLogsPanel from './RecordingLogsPanel';
import { getTeamById } from '../services/db';
import type { Team } from '../types';


const ManagerPanel: React.FC = () => {
    const { userData } = useAuth();
    const [activeTab, setActiveTab] = useState('scheduling');

    // Logic for multiple teams
    const [availableTeams, setAvailableTeams] = useState<Team[]>([]);
    const [currentTeamId, setCurrentTeamId] = useState<string>('');
    const [loadingTeams, setLoadingTeams] = useState(true);

    useEffect(() => {
        const fetchTeams = async () => {
            if (!userData) return;
            const ids = userData.teamIds || (userData.teamId ? [userData.teamId] : []);

            if (ids.length > 0) {
                try {
                    // Fetch details for all teams to display names
                    const promises = ids.map((id: string) => getTeamById(id));
                    const results = await Promise.all(promises);
                    const validTeams = results.filter((t: Team | null) => t !== null) as Team[];

                    setAvailableTeams(validTeams);
                    if (validTeams.length > 0) {
                        setCurrentTeamId(validTeams[0].id);
                    }
                } catch (e) {
                    console.error("Error fetching manager teams", e);
                }
            }
            setLoadingTeams(false);
        };

        fetchTeams();
    }, [userData]);

    const TabButton = ({ tabName, title }: { tabName: string, title: string }) => (
        <button
            onClick={() => setActiveTab(tabName)}
            className={`px-4 py-2 text-sm font-medium rounded-md ${activeTab === tabName ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
        >
            {title}
        </button>
    );

    if (loadingTeams) {
        return <div className="p-4 text-center">Loading team data...</div>;
    }

    if (availableTeams.length === 0) {
        return <p className="text-red-500 p-4">Error: You are not assigned to any team.</p>;
    }

    return (
        <div>
            <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-6">Manager Dashboard</h2>

            {/* Live Status Section - Shows ALL assigned teams */}
            <div className="mb-8 space-y-6">
                {availableTeams.map(team => (
                    <div key={team.id} className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 px-1">
                            <h3 className="text-lg font-bold text-gray-700 dark:text-gray-300">{team.name}</h3>
                            <span className="text-xs font-normal text-gray-500 dark:text-gray-400 px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border dark:border-gray-700">Live Status</span>
                        </div>
                        <TeamStatusView
                            teamId={team.id}
                            canControlRecording={true}
                            isMinimizable={true}
                        />
                    </div>
                ))}
            </div>

            <div className="border-t border-gray-300 dark:border-gray-600 my-8"></div>

            {/* Detailed Management Section - Controls Single Team Context */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <h3 className="text-xl font-semibold text-gray-800 dark:text-gray-200">Team Management</h3>

                {availableTeams.length > 1 && (
                    <div className="flex items-center gap-2 bg-white dark:bg-gray-800 p-2 rounded-lg shadow-sm border dark:border-gray-700">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Select Team:</span>
                        <select
                            value={currentTeamId}
                            onChange={(e) => setCurrentTeamId(e.target.value)}
                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-1.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        >
                            {availableTeams.map(team => (
                                <option key={team.id} value={team.id}>{team.name}</option>
                            ))}
                        </select>
                    </div>
                )}
                {availableTeams.length === 1 && (
                    <span className="text-sm text-gray-500 dark:text-gray-400 border px-3 py-1 rounded-full">
                        Managing: <span className="font-semibold text-gray-700 dark:text-gray-200">{availableTeams[0].name}</span>
                    </span>
                )}
            </div>

            <div className="mb-6 border-b border-gray-200 dark:border-gray-700">
                <nav className="flex flex-wrap gap-2" aria-label="Tabs">
                    <TabButton tabName="scheduling" title="Team Schedule" />
                    <TabButton tabName="reports" title="Reports" />
                    <TabButton tabName="recordingLogs" title="Recording Logs" />
                    <TabButton tabName="monitoring" title="Detailed Agent Monitoring" />
                </nav>
            </div>

            <div id="tab-content">
                {currentTeamId ? (
                    <>
                        {activeTab === 'monitoring' && <LiveMonitoringDashboard teamId={currentTeamId} />}
                        {activeTab === 'scheduling' && <SchedulingPanel teamId={currentTeamId} />}
                        {activeTab === 'reports' && <ReportsPanel teamId={currentTeamId} />}
                        {activeTab === 'recordingLogs' && <RecordingLogsPanel teamId={currentTeamId} />}
                    </>
                ) : (
                    <p className="text-gray-500">Please select a team to manage.</p>
                )}
            </div>
        </div>
    );
};

export default ManagerPanel;
