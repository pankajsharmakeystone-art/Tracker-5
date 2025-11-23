import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { streamGlobalAdminSettings, updateGlobalAdminSettings } from '../services/db';
import Spinner from './Spinner';
const FormField = ({ label, description, children }) => (_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-6 items-center py-4 border-b border-gray-200 dark:border-gray-700 last:border-b-0", children: [_jsxs("div", { className: "md:col-span-1", children: [_jsx("label", { className: "text-sm font-medium text-gray-900 dark:text-white", children: label }), _jsx("p", { className: "text-xs text-gray-500 dark:text-gray-400 mt-1", children: description })] }), _jsx("div", { className: "md:col-span-2", children: children })] }));
const ToggleSwitch = ({ checked, onChange, id }) => (_jsxs("label", { htmlFor: id, className: "relative inline-flex items-center cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: checked, onChange: onChange, id: id, className: "sr-only peer" }), _jsx("div", { className: "w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600" })] }));
const AdminSettings = () => {
    const defaultSettings = {
        allowRecording: false,
        autoUpload: false,
        dropboxToken: '',
        dropboxRefreshToken: '',
        dropboxAppKey: '',
        dropboxAppSecret: '',
        idleTimeout: 300,
        recordingMode: 'manual',
        requireLoginOnBoot: false,
        showRecordingNotification: false,
        recordingQuality: '720p',
        autoClockOutEnabled: false,
        manualBreakTimeoutMinutes: 30,
    };
    const [settings, setSettings] = useState(defaultSettings);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    useEffect(() => {
        setLoading(true);
        const unsubscribe = streamGlobalAdminSettings((data) => {
            if (data) {
                // Merge with default settings to ensure all fields exist
                setSettings((prev) => ({ ...defaultSettings, ...data }));
            }
            else {
                setSettings(defaultSettings);
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, []);
    const handleInputChange = (e) => {
        const { name, value, type } = e.target;
        let finalValue = value;
        if (type === 'number') {
            finalValue = value === '' ? 0 : parseInt(value, 10);
        }
        setSettings((prev) => ({ ...prev, [name]: finalValue }));
    };
    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            await updateGlobalAdminSettings(settings);
            setSuccess('Settings saved successfully!');
            setTimeout(() => setSuccess(null), 3000);
        }
        catch (err) {
            setError('Failed to save settings. Please try again.');
            console.error(err);
        }
        finally {
            setSaving(false);
        }
    };
    if (loading) {
        return _jsx("div", { className: "flex justify-center items-center p-8", children: _jsx(Spinner, {}) });
    }
    return (_jsxs("div", { className: "p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700", children: [_jsx("h3", { className: "text-lg font-medium text-gray-900 dark:text-white mb-4", children: "Application Settings" }), _jsx("p", { className: "text-sm text-gray-600 dark:text-gray-400 mb-6", children: "These settings apply globally to all users and teams, primarily for the desktop application." }), error && _jsx("p", { className: "text-sm text-red-500 mb-4 p-3 bg-red-100 dark:bg-red-900/50 rounded-md", children: error }), _jsxs("form", { onSubmit: handleSave, children: [_jsx(FormField, { label: "Require Login on Boot", description: "Force users to log in every time the desktop application starts.", children: _jsx(ToggleSwitch, { id: "requireLoginOnBoot", checked: settings.requireLoginOnBoot ?? false, onChange: (e) => setSettings((prev) => ({ ...prev, requireLoginOnBoot: e.target.checked })) }) }), _jsx(FormField, { label: "Allow Screen Recording", description: "Enable or disable the screen recording feature for all agents.", children: _jsx(ToggleSwitch, { id: "allowRecording", checked: settings.allowRecording ?? false, onChange: (e) => setSettings((prev) => ({ ...prev, allowRecording: e.target.checked })) }) }), _jsx(FormField, { label: "Recording Quality", description: "Select the target resolution for screen recordings.", children: _jsxs("select", { name: "recordingQuality", value: settings.recordingQuality, onChange: handleInputChange, className: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", children: [_jsx("option", { value: "480p", children: "480p" }), _jsx("option", { value: "720p", children: "720p (Default)" }), _jsx("option", { value: "1080p", children: "1080p" })] }) }), _jsx(FormField, { label: "Show Recording Notification", description: "Show a desktop notification when screen recording starts or stops.", children: _jsx(ToggleSwitch, { id: "showRecordingNotification", checked: settings.showRecordingNotification ?? false, onChange: (e) => setSettings((prev) => ({ ...prev, showRecordingNotification: e.target.checked })) }) }), _jsx(FormField, { label: "Recording Mode", description: "Set whether recording starts automatically on clock-in or must be started manually.", children: _jsxs("select", { name: "recordingMode", value: settings.recordingMode, onChange: handleInputChange, className: "bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", children: [_jsx("option", { value: "manual", children: "Manual" }), _jsx("option", { value: "auto", children: "Automatic" })] }) }), _jsx(FormField, { label: "Idle Timeout (seconds)", description: "Automatically clock out users after inactivity. Set to 0 to disable.", children: _jsx("input", { type: "number", name: "idleTimeout", value: settings.idleTimeout, onChange: handleInputChange, min: "0", className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "e.g., 300" }) }), _jsx(FormField, { label: "Auto Clock-Out", description: "Enable automatic clock-out based on the agent's scheduled shift end time.", children: _jsx("div", { className: "flex items-center gap-4", children: _jsx(ToggleSwitch, { id: "autoClockOutEnabled", checked: settings.autoClockOutEnabled, onChange: (e) => setSettings((prev) => ({ ...prev, autoClockOutEnabled: e.target.checked })) }) }) }), _jsx(FormField, { label: "Manual Break Timeout (minutes)", description: "Show a forced popup when a manual break exceeds this duration.", children: _jsx("input", { type: "number", name: "manualBreakTimeoutMinutes", value: settings.manualBreakTimeoutMinutes, onChange: handleInputChange, min: "1", className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "e.g., 30" }) }), _jsx(FormField, { label: "Auto-Upload Recordings", description: "Automatically upload screen recordings to Dropbox. Requires a refresh token + app credentials.", children: _jsx(ToggleSwitch, { id: "autoUpload", checked: settings.autoUpload ?? false, onChange: (e) => setSettings((prev) => ({ ...prev, autoUpload: e.target.checked })) }) }), _jsx(FormField, { label: "Dropbox Refresh Token", description: "Paste the long-lived refresh token generated with token_access_type=offline. This keeps uploads working after short-lived tokens expire.", children: _jsx("input", { type: "text", name: "dropboxRefreshToken", value: settings.dropboxRefreshToken || '', onChange: handleInputChange, className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "Enter Dropbox Refresh Token" }) }), _jsx(FormField, { label: "Dropbox App Key", description: "Optional override for the Dropbox app key (client_id). Leave blank to use the value bundled with the desktop app.", children: _jsx("input", { type: "text", name: "dropboxAppKey", value: settings.dropboxAppKey || '', onChange: handleInputChange, className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "Optional App Key" }) }), _jsx(FormField, { label: "Dropbox App Secret", description: "Optional override for the Dropbox app secret (client_secret). Required if you supply a custom app key.", children: _jsx("input", { type: "text", name: "dropboxAppSecret", value: settings.dropboxAppSecret || '', onChange: handleInputChange, className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "Optional App Secret" }) }), _jsx(FormField, { label: "Legacy Dropbox Access Token", description: "Optional: legacy long-lived access token fallback. Only used if no refresh token is configured.", children: _jsx("input", { type: "text", name: "dropboxToken", value: settings.dropboxToken, onChange: handleInputChange, className: "bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white", placeholder: "Enter Dropbox Token" }) }), _jsxs("div", { className: "mt-8 flex items-center gap-4", children: [_jsx("button", { type: "submit", disabled: saving, className: "text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50", children: saving ? 'Saving...' : 'Save Settings' }), success && _jsx("p", { className: "text-sm text-green-600 dark:text-green-400", children: success })] })] })] }));
};
export default AdminSettings;
