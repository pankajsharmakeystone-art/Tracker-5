
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { logout } from '../services/auth';
import { useAuth } from '../hooks/useAuth';
import { updateAgentStatus, performClockOut } from '../services/db';
import Spinner from '../components/Spinner';
import AdminPanel from '../components/AdminPanel';
import AgentPanel from '../components/AgentPanel';
import ManagerPanel from '../components/ManagerPanel';

const DashboardPage: React.FC = () => {
    const { user, userData, loading } = useAuth();
    const navigate = useNavigate();
    const [showError, setShowError] = useState(false);
    const [autoClockOutMessage, setAutoClockOutMessage] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    const [agentWebBlocked, setAgentWebBlocked] = useState(false);
    const currentUid = userData?.uid || user?.uid || null;
    const currentUidRef = useRef<string | null>(currentUid);
    const isDesktopEnv = typeof window !== 'undefined' && Boolean(window.desktopAPI);

    useEffect(() => {
        currentUidRef.current = currentUid;
    }, [currentUid]);
    
    useEffect(() => {
        let timer: number;
        // If loading is complete but we still don't have user data,
        // it might be a transient state or a real error.
        // We'll wait a brief moment before concluding it's an error.
        if (!loading && !userData) {
            timer = window.setTimeout(() => {
                setShowError(true);
            }, 1500); // 1.5 seconds grace period
        } else {
             setShowError(false);
        }

        // If loading or userData changes, clear any pending error display.
        return () => clearTimeout(timer);
    }, [loading, userData]);

    useEffect(() => {
        if (!loading && userData?.role === 'agent') {
            setAgentWebBlocked(!isDesktopEnv);
        } else {
            setAgentWebBlocked(false);
        }
    }, [loading, userData, isDesktopEnv]);

    useEffect(() => {
        if (!window.desktopAPI || !window.desktopAPI.onAutoClockOut) return;

        const handleAutoClockOut = async () => {
            setAutoClockOutMessage("You were automatically clocked out at shift end.");
            const targetUid = currentUidRef.current;
            if (!targetUid) return;
            try {
                await performClockOut(targetUid);
            } catch (error) {
                console.error("[DashboardPage] Failed to sync auto clock-out", error);
                setAutoClockOutMessage("Auto clock-out triggered, but we could not update your timesheet. Please review manually.");
            }
        };

        const cleanup = window.desktopAPI.onAutoClockOut(handleAutoClockOut);
        return () => {
            if (typeof cleanup === 'function') cleanup();
        };
    }, []);

    const performLogout = async () => {
        if (currentUid) {
            try {
                // Update Firestore agentStatus to offline and isDesktopConnected: false
                await updateAgentStatus(currentUid, 'offline', { isDesktopConnected: false });
            } catch (e) {
                console.error("Failed to update agent status during logout:", e);
            }
        }
        await logout();
        navigate('/login');
    };

    const handleAgentWebBlockedSignOut = async () => {
        await performLogout();
    };

    const handleSignOutClick = async () => {
        if (signingOut) return;
        setSigningOut(true);
        try {
            if (window.desktopAPI && window.desktopAPI.requestSignOut) {
                try {
                    await window.desktopAPI.requestSignOut();
                } catch (error) {
                    console.error("Error requesting sign out status:", error);
                }
            }
            // Don’t let a hung desktop IPC block logout; race with a timeout
            const desktopClockOut = (async () => {
                if (window.desktopAPI?.clockOutAndSignOut) {
                    try {
                        await window.desktopAPI.clockOutAndSignOut();
                    } catch (error) {
                        console.error("Error performing desktop clock out and sign out:", error);
                    }
                }
            })();
            await Promise.race([desktopClockOut, new Promise((resolve) => setTimeout(resolve, 5000))]);

            // Web-side clock out + logout
            if (currentUid) {
                 try {
                     await performClockOut(currentUid);
                 } catch (e) {
                     console.error("Error performing DB clock out:", e);
                 }
            }
            await performLogout();
        } finally {
            setSigningOut(false);
        }
    };

    // Kept for backward compatibility, but main sign-out flow now lives in handleSignOutClick
    const handleClockOutAndSignOut = async () => {
        return handleSignOutClick();
    };

    if (showError) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4 text-center">
                <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-8 dark:bg-gray-800 dark:border dark:border-gray-700">
                    <h1 className="text-2xl font-bold text-red-600 dark:text-red-500">Profile Error</h1>
                    <p className="mt-2 text-gray-600 dark:text-gray-300">
                        We couldn't load your user profile. This can happen if your account data is missing. Please sign out and try signing in again.
                    </p>
                    <button
                        onClick={handleSignOutClick}
                        className="mt-6 w-full inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-center text-white bg-red-600 rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:focus:ring-red-900">
                        Sign Out
                    </button>
                </div>
            </div>
        );
    }
    
    // Show a spinner while the initial auth check is running,
    // or if we don't have user data yet (covering the grace period).
    if (loading || !userData) {
        return (
             <div className="flex items-center justify-center min-h-screen">
                <Spinner />
            </div>
        )
    }

    if (agentWebBlocked) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4 text-center">
                <div className="w-full max-w-md bg-white rounded-lg shadow-xl p-8 dark:bg-gray-800 dark:border dark:border-gray-700">
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Use Desktop App</h1>
                    <p className="mt-3 text-gray-600 dark:text-gray-300">
                        Agent access is restricted to the desktop app. Please sign in using the desktop application to continue.
                    </p>
                    <button
                        onClick={handleAgentWebBlockedSignOut}
                        className="mt-6 w-full inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-center text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 dark:focus:ring-blue-900">
                        Sign Out
                    </button>
                </div>
            </div>
        );
    }
    
    const displayName = userData?.displayName || user?.displayName || user?.email;

    const renderContent = () => {
        switch (userData.role) {
            case 'admin':
                return <AdminPanel />;
            case 'manager':
                return <ManagerPanel />;
            case 'agent':
                 return <AgentPanel />;
            default:
                return <p className="text-red-500">Error: Invalid user role.</p>;
        }
    };


    return (
        <div className="flex flex-col items-center justify-start min-h-screen p-4 sm:p-6 md:p-8 relative">
            {autoClockOutMessage && (
                <div className="fixed top-4 right-4 z-50 p-4 mb-4 text-sm text-yellow-800 border border-yellow-300 rounded-lg bg-yellow-50 dark:bg-gray-800 dark:text-yellow-300 dark:border-yellow-800 shadow-lg max-w-sm" role="alert">
                    <div className="flex items-center">
                        <svg aria-hidden="true" className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"></path></svg>
                        <span className="sr-only">Info</span>
                        <h3 className="text-lg font-medium">Auto Clock-Out</h3>
                    </div>
                    <div className="mt-2 mb-4 text-sm">
                        {autoClockOutMessage}
                    </div>
                    <div className="flex">
                        <button type="button" onClick={() => setAutoClockOutMessage(null)} className="text-yellow-800 bg-transparent border border-yellow-800 hover:bg-yellow-900 hover:text-white focus:ring-4 focus:outline-none focus:ring-yellow-300 font-medium rounded-lg text-xs px-3 py-1.5 text-center dark:hover:bg-yellow-300 dark:border-yellow-300 dark:text-yellow-300 dark:hover:text-gray-800 dark:focus:ring-yellow-800" aria-label="Close">
                            Dismiss
                        </button>
                    </div>
                </div>
            )}

            <div className="w-full max-w-7xl bg-white rounded-lg shadow-xl dark:border p-6 sm:p-8 dark:bg-gray-800 dark:border-gray-700">
                 <div className="flex flex-col sm:flex-row justify-between sm:items-center mb-6 gap-4">
                    <div>
                        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
                            Dashboard
                        </h1>
                        <p className="text-lg text-gray-500 dark:text-gray-400 mt-1">
                            Welcome back, {displayName}!
                        </p>
                    </div>
                     <div className="flex items-center gap-4">
                        <button
                            onClick={handleSignOutClick}
                            disabled={signingOut}
                            className="w-full sm:w-auto inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-center text-white bg-red-600 rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:focus:ring-red-900 disabled:opacity-60 disabled:cursor-not-allowed">
                            {signingOut ? 'Signing Out…' : 'Sign Out'}
                        </button>
                    </div>
                </div>
                
                <div className="bg-gray-50 dark:bg-gray-900/50 p-6 rounded-lg border dark:border-gray-700">
                    {renderContent()}
                </div>
            </div>
        </div>
    );
};

export default DashboardPage;
