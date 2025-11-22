export interface BreakEntry {
    startTime: any;
    endTime: any;
}

export interface ActivityEntry {
    startTime: any;
    endTime: any;
}

export interface WorkLog {
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

    teamId?: string;
}

export interface TeamSettings {
    showLiveTeamStatus?: boolean;
}

export interface Team {
    id: string;
    name: string;
    ownerId: string;
    settings?: TeamSettings;
}
