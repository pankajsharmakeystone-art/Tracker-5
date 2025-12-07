
import React, { useState, useEffect, useMemo } from 'react';
import { streamGlobalAdminSettings, updateGlobalAdminSettings } from '../services/db';
import type { AdminSettingsType } from '../types';
import Spinner from './Spinner';
import { useAuth } from '../hooks/useAuth';

const resolveDropboxSessionEndpoint = () => {
    if (import.meta.env.VITE_DROPBOX_SESSION_ENDPOINT) {
        return import.meta.env.VITE_DROPBOX_SESSION_ENDPOINT;
    }
    return '/api/create-dropbox-session';
};

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
        showRecordingNotification: false,
        recordingQuality: '720p',
        autoClockOutEnabled: false,
        manualBreakTimeoutMinutes: 30,
        organizationTimezone: 'Asia/Kolkata',
        showLiveTeamStatusToAgents: true,
        loginReminderEnabled: false,
    };
    
    const [settings, setSettings] = useState<AdminSettingsType>(defaultSettings);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [tokenGenerating, setTokenGenerating] = useState(false);
    const [tokenMessage, setTokenMessage] = useState<string | null>(null);
    const [showDropboxChecklist, setShowDropboxChecklist] = useState(false);
    const dropboxSessionEndpoint = useMemo(() => resolveDropboxSessionEndpoint(), []);
    const dropboxCallbackHint = useMemo(() => {
        if (typeof window !== 'undefined' && window.location) {
            return `${window.location.origin}/api/dropbox-callback`;
        }
        return 'https://your-domain/api/dropbox-callback';
    }, []);
    const { currentUser } = useAuth();
    const timezoneOptions = useMemo(() => {
        if (typeof Intl !== 'undefined' && typeof (Intl as any).supportedValuesOf === 'function') {
            try {
                return (Intl as any).supportedValuesOf('timeZone');
            } catch {
                // fall through to fallback list
            }
        }
        return ['UTC', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin'];
    }, []);
    const canAutoGenerate = Boolean(settings.dropboxAppKey && settings.dropboxAppSecret);

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

    const handleGenerateDropboxToken = async () => {
        if (!currentUser) {
            setTokenMessage('Please sign in again to generate a Dropbox token.');
            return;
        }
        if (!settings.dropboxAppKey || !settings.dropboxAppSecret) {
            setTokenMessage('Enter your Dropbox app key and secret first.');
            return;
        }

        setTokenGenerating(true);
        setTokenMessage(null);

        try {
            const idToken = await currentUser.getIdToken();
            const response = await fetch(dropboxSessionEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    appKey: settings.dropboxAppKey,
                    appSecret: settings.dropboxAppSecret
                })
            });

            const data = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(data?.error || `Failed to start Dropbox OAuth (${response.status})`);
            }

            if (!data?.startUrl) {
                throw new Error('Server did not return the Dropbox authorization link.');
            }

            const popup = window.open(data.startUrl, 'dropboxOauthPopup', 'width=600,height=700');
            if (!popup) {
                throw new Error('Popup blocked. Please allow popups for this site and try again.');
            }
            popup.focus();
            setTokenMessage('Dropbox window opened. Complete the consent flow, then return here. Tokens update automatically.');
        } catch (err) {
            setTokenMessage((err as Error).message || 'Unable to start Dropbox authorization.');
        } finally {
            setTokenGenerating(false);
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
                <FormField label="Allow Screen Recording" description="Enable or disable the screen recording feature for all agents.">
                     <ToggleSwitch
                        id="allowRecording"
                        checked={settings.allowRecording ?? false}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, allowRecording: e.target.checked }))}
                    />
                </FormField>

                <FormField label="Show Team Status To Agents" description="When enabled, agents can view the Live Team Status widget for their own team inside the dashboard.">
                    <ToggleSwitch
                        id="showLiveTeamStatusToAgents"
                        checked={settings.showLiveTeamStatusToAgents ?? true}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, showLiveTeamStatusToAgents: e.target.checked }))}
                    />
                </FormField>

                <FormField label="Login Reminder" description="When enabled, the desktop app persistently prompts agents until they sign in and clock in.">
                    <ToggleSwitch
                        id="loginReminderEnabled"
                        checked={settings.loginReminderEnabled ?? false}
                        onChange={(e) => setSettings((prev: AdminSettingsType) => ({ ...prev, loginReminderEnabled: e.target.checked }))}
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

                <FormField
                    label="Organization Timezone"
                    description="Schedules, desktop reminders, and auto clock-out logic run in this timezone."
                >
                    <select
                        name="organizationTimezone"
                        value={settings.organizationTimezone || 'Asia/Kolkata'}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full max-w-xs p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                    >
                        {timezoneOptions.map((tz: string) => (
                            <option key={tz} value={tz}>{tz}</option>
                        ))}
                    </select>
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

                <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-gray-800 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-50">
                    <button
                        type="button"
                        onClick={() => setShowDropboxChecklist((prev) => !prev)}
                        className="flex w-full items-center justify-between text-left font-semibold text-blue-900 dark:text-blue-100"
                    >
                        <span>Dropbox setup checklist</span>
                        <span>{showDropboxChecklist ? '− Hide' : '+ Show'}</span>
                    </button>
                    {showDropboxChecklist && (
                        <div className="mt-3 space-y-2">
                            <ol className="list-decimal list-inside space-y-2">
                                <li>
                                    Sign in to the <a className="text-blue-700 underline dark:text-blue-200" href="https://www.dropbox.com/developers/apps" target="_blank" rel="noreferrer">Dropbox App Console</a>, create/select an app, and copy the <strong>App key</strong> and <strong>App secret</strong> from the Settings tab.
                                </li>
                                <li>
                                    On the Permissions tab, enable at least <code>files.content.write</code> and <code>files.metadata.write</code> so uploads are allowed.
                                </li>
                                <li>
                                    From your hosting provider (Vercel, Netlify, custom DNS, etc.) copy the exact domain where this dashboard is deployed. Append <code>/api/dropbox-callback</code> and add that full URL to Dropbox → Redirect URIs. Example based on this window: <code>{dropboxCallbackHint}</code>.
                                </li>
                                <li>
                                    Paste the App key + secret in the fields below and click <strong>Save Settings</strong> so the desktop + dashboard use the same credentials.
                                </li>
                                <li>
                                    Click <strong>Generate Refresh Token</strong>, approve the popup, and wait for the success screen—tokens update in Firestore automatically.
                                </li>
                            </ol>
                            <p className="text-xs text-gray-600 dark:text-blue-200">
                                Need to change domains later? Update the redirect URI within Dropbox and, if applicable, adjust <code>VITE_DROPBOX_SESSION_ENDPOINT</code> before rerunning the flow.
                            </p>
                        </div>
                    )}
                </div>

                <FormField label="Dropbox Refresh Token" description="Click Generate to run the Dropbox OAuth popup or paste an existing refresh token manually.">
                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            name="dropboxRefreshToken"
                            value={settings.dropboxRefreshToken || ''}
                            onChange={handleInputChange}
                            className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                            placeholder="Dropbox Refresh Token"
                        />
                        <div className="flex flex-col sm:flex-row gap-3">
                            <button
                                type="button"
                                onClick={handleGenerateDropboxToken}
                                disabled={tokenGenerating || !canAutoGenerate}
                                className="inline-flex items-center justify-center text-white bg-emerald-600 hover:bg-emerald-700 focus:ring-4 focus:outline-none focus:ring-emerald-300 font-medium rounded-lg text-sm px-4 py-2.5 dark:bg-emerald-600 dark:hover:bg-emerald-700 disabled:opacity-50"
                            >
                                {tokenGenerating ? 'Opening Dropbox…' : 'Generate Refresh Token'}
                            </button>
                        </div>
                        {!canAutoGenerate && (
                            <p className="text-xs text-amber-600 dark:text-amber-400">
                                Provide both the Dropbox app key and secret above to enable the automatic flow.
                            </p>
                        )}
                        {tokenMessage && (
                            <p className="text-xs text-emerald-600 dark:text-emerald-400">{tokenMessage}</p>
                        )}
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            Manual fallback: visit the Dropbox developer console, authorize your app with <code>token_access_type=offline</code>, and paste the refresh token above.
                        </p>
                    </div>
                </FormField>

                <FormField label="Dropbox App Key" description="Required when using the Generate button. This matches the client_id from the Dropbox developer console.">
                    <input
                        type="text"
                        name="dropboxAppKey"
                        value={settings.dropboxAppKey || ''}
                        onChange={handleInputChange}
                        className="bg-gray-50 border border-gray-300 text-gray-900 sm:text-sm rounded-lg focus:ring-blue-600 focus:border-blue-600 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white"
                        placeholder="Optional App Key"
                    />
                </FormField>

                <FormField label="Dropbox App Secret" description="Required when using the Generate button. Keep this value private.">
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
