
import type { User as FirebaseUser } from 'firebase/auth';
import type { Timestamp } from 'firebase/firestore';

// Electron Desktop App API
declare global {
  interface Window {
    currentUserUid?: string;
    desktopAPI?: {
      registerUid: (uid: string) => void;
      onCommandStartRecording: (callback: ({ uid }: { uid: string }) => void) => void;
      onCommandStopRecording: (callback: () => void) => void;
      onSettingsUpdated: (callback: (settings: any) => void) => void;
      notifyRecordingSaved: (fileName: string, data: ArrayBuffer) => Promise<void>;
      requestScreenSources: () => Promise<{ 
        success: boolean; 
        sources: Array<{ id: string; name: string; thumbnail?: string }>; 
        resolution?: { width: number; height: number };
        error?: string 
      }>;
      setAgentStatus: (status: string) => void;
      requestSignOut: () => Promise<{ clockedIn: boolean }>;
      clockOutAndSignOut: () => Promise<void>;
      onAutoClockOut: (callback: () => void) => void;
    };
  }
}

export type User = FirebaseUser | null;

export type Role = 'admin' | 'manager' | 'agent';

export interface TeamSettings {
  showLiveTeamStatus: boolean;
}

export interface AdminSettings {
  allowRecording: boolean;
  autoUpload: boolean;
  dropboxToken: string;
  idleTimeout: number;
  recordingMode: 'manual' | 'auto';
  requireLoginOnBoot: boolean;
  showRecordingNotification: boolean;
  // New fields
  recordingQuality: '480p' | '720p' | '1080p';
  autoClockOutEnabled: boolean;
  manualBreakTimeoutMinutes: number;
}

export interface Team {
  id: string;
  name: string;
  ownerId: string;
  createdAt: any; // serverTimestamp
  settings?: TeamSettings;
}

export interface UserData {
  uid: string;
  email: string | null;
  displayName: string | null;
  createdAt: any; // serverTimestamp
  role: Role;
  teamId?: string; // Kept for primary context/legacy support
  teamIds?: string[]; // Support for multiple teams
}

export interface AuthContextType {
  user: User;
  userData: UserData | null;
  loading: boolean;
}

// Time Tracking Types
export type WorkLogStatus = 'clocked_out' | 'working' | 'on_break';

export interface Break {
  startTime: any; // serverTimestamp
  endTime: any | null; // serverTimestamp
}

export interface WorkLog {
  id: string;
  userId: string;
  userDisplayName: string; // Added for monitoring
  teamId: string; // Added for team-based filtering
  
  // Session Data
  startTime: any; // serverTimestamp (The exact moment the session started)
  date: any; // serverTimestamp (Kept for indexing: The date the session started)
  
  clockInTime: any | null; // serverTimestamp
  clockOutTime: any | null; // serverTimestamp
  
  totalWorkSeconds: number;
  totalBreakSeconds: number;
  status: WorkLogStatus;
  lastEventTimestamp: any | null; // serverTimestamp
  breaks: Break[];
  
  // Late Login Logic
  lateMinutes?: number; // Minutes late for the session start
  scheduledStart?: string; // "HH:MM" stored from schedule
  scheduledEnd?: string; // "HH:MM" stored from schedule
  isOvernightShift?: boolean; // New field to track if shift crosses midnight
}

// Scheduling Types
export interface ShiftTime {
    startTime: string; // "HH:MM"
    endTime: string; // "HH:MM"
}

export interface Schedule {
    // Key is YYYY-MM-DD
    [date: string]: ShiftTime | 'OFF' | 'L'; // Value is custom shift or 'OFF' or 'L'
}

export interface MonthlySchedule {
    // Key is userId
    [userId: string]: Schedule;
}