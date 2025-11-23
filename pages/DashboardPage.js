import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { logout } from '../services/auth';
import { useAuth } from '../hooks/useAuth';
import { updateAgentStatus, performClockOut } from '../services/db';
import Spinner from '../components/Spinner';
import AdminPanel from '../components/AdminPanel';
import AgentPanel from '../components/AgentPanel';
import ManagerPanel from '../components/ManagerPanel';
const SignOutModal = ({ isOpen, onClose, onSignOutOnly, onClockOutAndSignOut }) => {
    if (!isOpen)
        return null;
    return (_jsx("div", { className: "fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60 p-4", "aria-modal": "true", role: "dialog", children: _jsxs("div", { className: "bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 border dark:border-gray-700", children: [_jsx("h2", { className: "text-xl font-bold text-gray-900 dark:text-white mb-2", children: "You are still clocked in" }), _jsx("p", { className: "text-gray-600 dark:text-gray-300 mb-6", children: "Do you want to Sign Out only, or Clock Out & Sign Out to end your shift?" }), _jsxs("div", { className: "flex flex-col gap-3", children: [_jsx("button", { onClick: onSignOutOnly, className: "w-full px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-600", children: "Sign Out Only" }), _jsx("button", { onClick: onClockOutAndSignOut, className: "w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700", children: "Clock Out & Sign Out" }), _jsx("button", { onClick: onClose, className: "w-full px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300", children: "Cancel" })] })] }) }));
};
const DashboardPage = () => {
    const { user, userData, loading } = useAuth();
    const navigate = useNavigate();
    const [showError, setShowError] = useState(false);
    const [showSignOutModal, setShowSignOutModal] = useState(false);
    const [autoClockOutMessage, setAutoClockOutMessage] = useState(null);
    useEffect(() => {
        let timer;
        // If loading is complete but we still don't have user data,
        // it might be a transient state or a real error.
        // We'll wait a brief moment before concluding it's an error.
        if (!loading && !userData) {
            timer = window.setTimeout(() => {
                setShowError(true);
            }, 1500); // 1.5 seconds grace period
        }
        else {
            setShowError(false);
        }
        // If loading or userData changes, clear any pending error display.
        return () => clearTimeout(timer);
    }, [loading, userData]);
    useEffect(() => {
        // Listen for auto clock out events from desktop
        if (window.desktopAPI && window.desktopAPI.onAutoClockOut) {
            window.desktopAPI.onAutoClockOut(() => {
                setAutoClockOutMessage("You were automatically clocked out at shift end.");
            });
        }
    }, []);
    const performLogout = async () => {
        if (userData?.uid) {
            try {
                // Update Firestore agentStatus to offline and isDesktopConnected: false
                await updateAgentStatus(userData.uid, 'offline', { isDesktopConnected: false });
            }
            catch (e) {
                console.error("Failed to update agent status during logout:", e);
            }
        }
        await logout();
        navigate('/login');
    };
    const handleSignOutClick = async () => {
        // If desktop API is available, check clock-in status
        if (window.desktopAPI && window.desktopAPI.requestSignOut) {
            try {
                const response = await window.desktopAPI.requestSignOut();
                if (response.clockedIn) {
                    setShowSignOutModal(true);
                    return;
                }
            }
            catch (error) {
                console.error("Error requesting sign out status:", error);
                // Fallthrough to normal logout on error
            }
        }
        // Standard logout if not on desktop or not clocked in
        performLogout();
    };
    const handleClockOutAndSignOut = async () => {
        // 1. Notify Desktop
        if (window.desktopAPI && window.desktopAPI.clockOutAndSignOut) {
            try {
                await window.desktopAPI.clockOutAndSignOut();
            }
            catch (error) {
                console.error("Error performing clock out and sign out:", error);
            }
        }
        // 2. Perform DB updates (Worklog, AgentStatus, UserDoc)
        if (userData?.uid) {
            try {
                await performClockOut(userData.uid);
            }
            catch (e) {
                console.error("Error performing DB clock out:", e);
            }
        }
        setShowSignOutModal(false);
        performLogout();
    };
    if (showError) {
        return (_jsx("div", { className: "flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4 text-center", children: _jsxs("div", { className: "w-full max-w-md bg-white rounded-lg shadow-xl p-8 dark:bg-gray-800 dark:border dark:border-gray-700", children: [_jsx("h1", { className: "text-2xl font-bold text-red-600 dark:text-red-500", children: "Profile Error" }), _jsx("p", { className: "mt-2 text-gray-600 dark:text-gray-300", children: "We couldn't load your user profile. This can happen if your account data is missing. Please sign out and try signing in again." }), _jsx("button", { onClick: performLogout, className: "mt-6 w-full inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-center text-white bg-red-600 rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:focus:ring-red-900", children: "Sign Out" })] }) }));
    }
    // Show a spinner while the initial auth check is running,
    // or if we don't have user data yet (covering the grace period).
    if (loading || !userData) {
        return (_jsx("div", { className: "flex items-center justify-center min-h-screen", children: _jsx(Spinner, {}) }));
    }
    const displayName = userData?.displayName || user?.displayName || user?.email;
    const renderContent = () => {
        switch (userData.role) {
            case 'admin':
                return _jsx(AdminPanel, {});
            case 'manager':
                return _jsx(ManagerPanel, {});
            case 'agent':
                return _jsx(AgentPanel, {});
            default:
                return _jsx("p", { className: "text-red-500", children: "Error: Invalid user role." });
        }
    };
    return (_jsxs("div", { className: "flex flex-col items-center justify-start min-h-screen p-4 sm:p-6 md:p-8 relative", children: [autoClockOutMessage && (_jsxs("div", { className: "fixed top-4 right-4 z-50 p-4 mb-4 text-sm text-yellow-800 border border-yellow-300 rounded-lg bg-yellow-50 dark:bg-gray-800 dark:text-yellow-300 dark:border-yellow-800 shadow-lg max-w-sm", role: "alert", children: [_jsxs("div", { className: "flex items-center", children: [_jsx("svg", { "aria-hidden": "true", className: "w-5 h-5 mr-2", fill: "currentColor", viewBox: "0 0 20 20", xmlns: "http://www.w3.org/2000/svg", children: _jsx("path", { fillRule: "evenodd", d: "M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z", clipRule: "evenodd" }) }), _jsx("span", { className: "sr-only", children: "Info" }), _jsx("h3", { className: "text-lg font-medium", children: "Auto Clock-Out" })] }), _jsx("div", { className: "mt-2 mb-4 text-sm", children: autoClockOutMessage }), _jsx("div", { className: "flex", children: _jsx("button", { type: "button", onClick: () => setAutoClockOutMessage(null), className: "text-yellow-800 bg-transparent border border-yellow-800 hover:bg-yellow-900 hover:text-white focus:ring-4 focus:outline-none focus:ring-yellow-300 font-medium rounded-lg text-xs px-3 py-1.5 text-center dark:hover:bg-yellow-300 dark:border-yellow-300 dark:text-yellow-300 dark:hover:text-gray-800 dark:focus:ring-yellow-800", "aria-label": "Close", children: "Dismiss" }) })] })), _jsx(SignOutModal, { isOpen: showSignOutModal, onClose: () => setShowSignOutModal(false), onSignOutOnly: () => { setShowSignOutModal(false); performLogout(); }, onClockOutAndSignOut: handleClockOutAndSignOut }), _jsxs("div", { className: "w-full max-w-7xl bg-white rounded-lg shadow-xl dark:border p-6 sm:p-8 dark:bg-gray-800 dark:border-gray-700", children: [_jsxs("div", { className: "flex flex-col sm:flex-row justify-between sm:items-center mb-6 gap-4", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-3xl font-bold text-gray-900 dark:text-white", children: "Dashboard" }), _jsxs("p", { className: "text-lg text-gray-500 dark:text-gray-400 mt-1", children: ["Welcome back, ", displayName, "!"] })] }), _jsx("div", { className: "flex items-center gap-4", children: _jsx("button", { onClick: handleSignOutClick, className: "w-full sm:w-auto inline-flex items-center justify-center px-5 py-2.5 text-sm font-medium text-center text-white bg-red-600 rounded-lg hover:bg-red-700 focus:ring-4 focus:ring-red-300 dark:focus:ring-red-900", children: "Sign Out" }) })] }), _jsx("div", { className: "bg-gray-50 dark:bg-gray-900/50 p-6 rounded-lg border dark:border-gray-700", children: renderContent() })] })] }));
};
export default DashboardPage;
