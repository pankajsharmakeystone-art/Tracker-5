import type { User as FirebaseAuthUser } from 'firebase/auth';

export interface BreakEntry {
    startTime: any;
    endTime: any;
    cause?: 'manual' | 'idle';
}

export type ActivityType = 'working' | 'on_break';

export interface ActivityEntry {
    type: ActivityType;
    startTime: any;
    endTime: any | null;
    cause?: 'manual' | 'idle';
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
    organizationTimezone?: string;
    showLiveTeamStatusToAgents?: boolean;
}

declare global {
    interface Window {
        desktopAPI?: {
            onReady: (callback: (data: any) => void) => void;
            onRegistered: (callback: (data: any) => void) => void;
            onAuthRequired?: (callback: (data?: { reason?: string }) => void) => (() => void) | void;
            registerUid: (payload: string | { uid: string; desktopToken?: string }) => Promise<any>;
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
        };
        currentUserUid?: string;
    }
}
