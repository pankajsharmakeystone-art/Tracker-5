
import React, { useState, useEffect } from 'react';
import { streamGlobalAdminSettings, updateGlobalAdminSettings } from '../services/db';
import type { AdminSettingsType } from '../types';
import Spinner from './Spinner';

interface FormFieldProps {
    label: string;
    description: string;
    children: React.ReactNode;
}

const FormField: React.FC<FormFieldProps> = ({ label, description, children }) => (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-6 items-center py-4 border-b border-gray-200 dark:border-gray-700 last:border-b-0">
        <div className="md:col-span-1">
            <label className="text-sm font-medium text-gray-900 dark:text-white">{label}</label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>
        </div>
        <div className="md:col-span-2">
            {children}
        </div>
    </div>
);

interface ToggleSwitchProps {
    checked: boolean;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    id: string;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange, id }) => (
    <label htmlFor={id} className="relative inline-flex items-center cursor-pointer">
        <input
            type="checkbox"
            checked={checked}
            onChange={onChange}
            id={id}
            className="sr-only peer"
        />
        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
    </label>
);

const AdminSettings: React.FC = () => {
    const defaultSettings: AdminSettingsType = {
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
    
    const [settings, setSettings] = useState<AdminSettingsType>(defaultSettings);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        const unsubscribe = streamGlobalAdminSettings((data) => {
            if (data) {
                // Merge with default settings to ensure all fields exist
                setSettings((prev: AdminSettingsType) => ({ ...defaultSettings, ...data }));
            } else {
                setSettings(defaultSettings);
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, []);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        
        let finalValue: string | number = value;
        if (type === 'number') {
            finalValue = value === '' ? 0 : parseInt(value, 10);
        }

        setSettings((prev: AdminSettingsType) => ({ ...prev, [name]: finalValue }));
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            await updateGlobalAdminSettings(settings);
            setSuccess('Settings saved successfully!');
            setTimeout(() => setSuccess(null), 3000);
        } catch (err) {
            setError('Failed to save settings. Please try again.');
            console.error(err);
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div className="flex justify-center items-center p-8"><Spinner /></div>;
    }

    return (
        <div className="p-4 bg-gray-100 dark:bg-gray-800/50 rounded-lg border dark:border-gray-700">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-4">Application Settings</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                These settings apply globally to all users and teams, primarily for the desktop application.
            </p>
            
            {error && <p className="text-sm text-red-500 mb-4 p-3 bg-red-100 dark:bg-red-900/50 rounded-md">{error}</p>}
            
            <form onSubmit={handleSave}>
                <FormField label="Require Login on Boot" description="Force users to log in every time the desktop application starts.">
                    <ToggleSwitch
                        id="requireLoginOnBoot"
                        checked={settings.requireLoginOnBoot ?? false}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, requireLoginOnBoot: e.target.checked }))}
                    />
                </FormField>
                
                <FormField label="Allow Screen Recording" description="Enable or disable the screen recording feature for all agents.">
                     <ToggleSwitch
                        id="allowRecording"
                        checked={settings.allowRecording ?? false}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, allowRecording: e.target.checked }))}
                    />
                </FormField>

                <FormField label="Recording Quality" description="Select the target resolution for screen recordings.">
                    <select
                        name="recordingQuality"
                        value={settings.recordingQuality}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                    >
                        <option value="480p">480p</option>
                        <option value="720p">720p (Default)</option>
                        <option value="1080p">1080p</option>
                    </select>
                </FormField>

                <FormField label="Show Recording Notification" description="Show a desktop notification when screen recording starts or stops.">
                     <ToggleSwitch
                        id="showRecordingNotification"
                        checked={settings.showRecordingNotification ?? false}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, showRecordingNotification: e.target.checked }))}
                    />
                </FormField>
                
                <FormField label="Recording Mode" description="Set whether recording starts automatically on clock-in or must be started manually.">
                    <select
                        name="recordingMode"
                        value={settings.recordingMode}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                    >
                        <option value="manual">Manual</option>
                        <option value="auto">Automatic</option>
                    </select>
                </FormField>
                
                <FormField label="Idle Timeout (seconds)" description="Automatically clock out users after inactivity. Set to 0 to disable.">
                    <input
                        type="number"
                        name="idleTimeout"
                        value={settings.idleTimeout}
                        onChange={handleInputChange}
                        min="0"
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="e.g., 300"
                    />
                </FormField>

                 <FormField label="Auto Clock-Out" description="Enable automatic clock-out based on the agent's scheduled shift end time.">
                    <div className="flex items-center gap-4">
                        <ToggleSwitch
                            id="autoClockOutEnabled"
                            checked={settings.autoClockOutEnabled}
                            onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, autoClockOutEnabled: e.target.checked }))}
                        />
                    </div>
                </FormField>

                <FormField label="Manual Break Timeout (minutes)" description="Show a forced popup when a manual break exceeds this duration.">
                    <input
                        type="number"
                        name="manualBreakTimeoutMinutes"
                        value={settings.manualBreakTimeoutMinutes}
                        onChange={handleInputChange}
                        min="1"
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="e.g., 30"
                    />
                </FormField>

                <FormField label="Auto-Upload Recordings" description="Automatically upload screen recordings to Dropbox. Requires a refresh token + app credentials.">
                     <ToggleSwitch
                        id="autoUpload"
                        checked={settings.autoUpload ?? false}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, autoUpload: e.target.checked }))}
                    />
                </FormField>

                <FormField label="Dropbox Refresh Token" description="Paste the long-lived refresh token generated with token_access_type=offline. This keeps uploads working after short-lived tokens expire.">
                    <input
                        type="text"
                        name="dropboxRefreshToken"
                        value={settings.dropboxRefreshToken || ''}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="Enter Dropbox Refresh Token"
                    />
                </FormField>

                <FormField label="Dropbox App Key" description="Optional override for the Dropbox app key (client_id). Leave blank to use the value bundled with the desktop app.">
                    <input
                        type="text"
                        name="dropboxAppKey"
                        value={settings.dropboxAppKey || ''}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="Optional App Key"
                    />
                </FormField>

                <FormField label="Dropbox App Secret" description="Optional override for the Dropbox app secret (client_secret). Required if you supply a custom app key.">
                    <input
                        type="text"
                        name="dropboxAppSecret"
                        value={settings.dropboxAppSecret || ''}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="Optional App Secret"
                    />
                </FormField>

                <FormField label="Legacy Dropbox Access Token" description="Optional: legacy long-lived access token fallback. Only used if no refresh token is configured.">
                    <input
                        type="text"
                        name="dropboxToken"
                        value={settings.dropboxToken}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="Enter Dropbox Token"
                    />
                </FormField>
                
                 <div className="mt-8 flex items-center gap-4">
                    <button type="submit" disabled={saving} className="text-white bg-blue-600 hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800 disabled:opacity-50">
                        {saving ? 'Saving...' : 'Save Settings'}
                    </button>
                    {success && <p className="text-sm text-green-600 dark:text-green-400">{success}</p>}
                </div>
            </form>
        </div>
    );
};

export default AdminSettings;
