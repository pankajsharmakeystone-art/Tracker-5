import type { User as FirebaseAuthUser } from 'firebase/auth';

export interface BreakEntry {
    startTime: any;
    endTime: any;
    cause?: 'manual' | 'idle' | 'away';
}

export type ActivityType = 'working' | 'on_break';

export interface ActivityEntry {
    type: ActivityType;
    startTime: any;
    endTime: any | null;
    cause?: 'manual' | 'idle';
}

// --- App & Website Tracking ---

export type AppCategory = 'productive' | 'social' | 'entertainment' | 'communication' | 'design' | 'development' | 'uncategorized';

export interface AppActivityEntry {
    app: string;
    title: string;
    category: AppCategory;
    startTime: any;
    endTime: any;
    durationSeconds: number;
    url?: string;
    source?: 'idle_avoid';
    detectionReason?: string;
}

export interface AppActivitySummary {
    userId: string;
    date: string;
    totalTrackedSeconds: number;
    byCategory: Record<AppCategory, number>;
    topApps: Array<{ app: string; category: AppCategory; seconds: number }>;
    entries: AppActivityEntry[];
}

export interface AppCategoryRule {
    pattern: string;
    category: AppCategory;
    type: 'app' | 'title';
}

export interface AppAlert {
    id: string;
    userId: string;
    userDisplayName: string;
    app: string;
    title: string;
    category: AppCategory;
    timestamp: number;
    teamId?: string;
    alertType?: 'red_flag' | 'idle_avoid';
    durationSeconds?: number;
    detectionReason?: string;
}

export interface WorkLog {
    id: string;
    userId: string;
    userDisplayName: string;

    clockInTime: any;
    clockOutTime: any;

    date: any;
    lastEventTimestamp: any;

    status: "active" | "on_break" | "working" | "clocked_out";

    // 🔥 REQUIRED FIELDS (this is what fixed your error)
    breaks: BreakEntry[];
    activities: ActivityEntry[];

    totalWorkSeconds: number;
    totalBreakSeconds: number;
    onDesktopRequestEndBreak?: (callback: (data?: any) => void) => (() => void) | void;

    teamId?: string;
    startTime?: any;
    lateMinutes?: number;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    isOvernightShift?: boolean;
}

export interface TeamSettings {
    showLiveTeamStatus?: boolean;
}

export interface Team {
    id: string;
    name: string;
    ownerId: string;
    settings?: TeamSettings;
    createdAt?: any;
}

export type Role = "admin" | "manager" | "agent";

export type User = FirebaseAuthUser;

export interface UserData {
    uid: string;
    email: string;
    role: Role;
    roles?: Role[];
    displayName: string;
    teamId?: string;
    teamIds?: string[];
    createdAt?: any;
}

export interface AuthContextType {
    currentUser: User | null;
    user: User | null;
    userData: UserData | null;
    loading: boolean;
    logout: () => Promise<void>;
}

export interface ShiftTime {
    startTime: string;
    endTime: string;
}

export type ShiftEntry = ShiftTime | 'OFF' | 'L';

export interface Schedule {
    userId: string;
    shifts: {
        [date: string]: ShiftEntry;
    };
}

export interface MonthlySchedule {
    [userId: string]: {
        [date: string]: ShiftEntry;
    };
}

export interface AdminSettingsType {
    autoClockOutEnabled: boolean;
    idleTimeout: number;
    autoClockGraceMinutes?: number;
    dropboxToken?: string;
    dropboxRefreshToken?: string;
    dropboxAccessToken?: string;
    dropboxTokenExpiry?: string | number;
    dropboxAppKey?: string;
    dropboxAppSecret?: string;
    uploadToDropbox?: boolean;
    uploadToGoogleSheets?: boolean;
    uploadToHttp?: boolean;
    httpUploadUrl?: string;
    httpUploadToken?: string;
    httpUploadFfmpegRepairEnabled?: boolean;
    googleServiceAccountJson?: string;
    googleSpreadsheetId?: string;
    googleSpreadsheetTabName?: string;
    googleDriveFolderId?: string;
    recordingMode?: "auto" | "manual" | "off";
    requireLoginOnBoot?: boolean;
    autoUpload?: boolean;
    showRecordingNotification?: boolean;
    manualBreakTimeoutMinutes?: number;
    allowRecording?: boolean;
    recordingQuality?: "480p" | "720p" | "1080p";
    recordingFps?: 30 | 60 | 120;
    recordingSegmentMinutes?: number;
    desktopDebugMachines?: string[];
    organizationTimezone?: string;
    showLiveTeamStatusToAgents?: boolean;
    enableAppTracking?: boolean;
    appTrackingIntervalSeconds?: number;
    appCategoryRules?: AppCategoryRule[];
    redFlagCategories?: AppCategory[];
}

declare global {
    interface Window {
        desktopAPI?: {
            onReady: (callback: (data: any) => void) => void;
            onRegistered: (callback: (data: any) => void) => void;
            onAuthRequired?: (callback: (data?: { reason?: string }) => void) => (() => void) | void;
            registerUid: (payload: string | { uid: string; desktopToken?: string; deviceId?: string }) => Promise<any>;
            unregisterUid: () => Promise<any>;
            setAgentStatus: (status: string) => Promise<any>;
            requestScreenSources: () => Promise<any>;
            stopRecording: (meta?: { autoRetry?: boolean; reason?: string }) => Promise<any>;
            notifyRecordingSaved: (fileName: string, data: any, meta?: { isLastSession?: boolean }) => Promise<any>;
            getIdleTime: () => Promise<number>;
            uploadToDropbox: (filePath: string) => Promise<any>;
            getRecordingQuality: () => Promise<any>;
            requestSignOut: () => Promise<any>;
            clockOutAndSignOut: () => Promise<any>;
            onCommandStartRecording: (callback: (data: any) => void) => void;
            onCommandStopRecording: (callback: (data: any) => void) => void;
            onCommandForceBreak: (callback: (data: any) => void) => void;
            onSettingsUpdated: (callback: (data: any) => void) => void;
            onDesktopRequestEndBreak?: (callback: (data?: any) => void) => (() => void) | void;
            syncAdminSettings?: (settings: AdminSettingsType | null) => Promise<any>;
            onAutoClockOut: (callback: (data: any) => void) => (() => void) | void;
            onSignedOut?: (callback: (data?: { reason?: string }) => void) => (() => void) | void;
            reportError?: (payload: any) => Promise<any>;
            onAutoUpdateStatus?: (callback: (data: { event: string; version?: string; percent?: number; message?: string }) => void) => (() => void) | void;
            requestImmediateUpdateCheck?: () => Promise<any>;
            installPendingUpdate?: () => Promise<any>;
            ping: () => Promise<any>;
            minimizeToTray: () => void;
            setAutoLaunch: (enable: boolean) => Promise<any>;
            endBreak: () => Promise<any>;
            getLiveStreamSources: () => Promise<{
                success: boolean;
                sources?: Array<{ id: string; name: string }>;
                resolution?: { width: number; height: number };
                error?: string;
            }>;
            getAppTrackingStatus?: () => Promise<{ enabled: boolean; currentApp?: string; currentCategory?: string }>;
            onAppTrackingUpdate?: (cb: (data: { app: string; title: string; category: string }) => void) => (() => void) | void;
        };
        currentUserUid?: string;
    }
}
