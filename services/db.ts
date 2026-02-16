
import { doc, setDoc, getDoc, serverTimestamp, collection, query, where, getDocs, addDoc, limit, updateDoc, Timestamp, arrayUnion, increment, onSnapshot, deleteDoc, deleteField, orderBy } from 'firebase/firestore';
import { DateTime } from 'luxon';
import { db } from './firebase';
import type { User as FirebaseUser } from 'firebase/auth';
import type { UserData, Role, Team, WorkLog, MonthlySchedule, AdminSettingsType, ShiftTime, ShiftEntry } from '../types';

const DEFAULT_ORGANIZATION_TIMEZONE = 'Asia/Kolkata';

export const readOrganizationTimezone = async (): Promise<string> => {
    try {
        const settingsRef = doc(db, 'adminSettings', 'global');
        const snap = await getDoc(settingsRef);
        if (snap.exists()) {
            const data = snap.data() as AdminSettingsType;
            return data.organizationTimezone || DEFAULT_ORGANIZATION_TIMEZONE;
        }
    } catch (error) {
        console.error('Failed to load organization timezone', error);
    }
    return DEFAULT_ORGANIZATION_TIMEZONE;
};

// --- User Management ---

export const createUserDocument = async (userAuth: FirebaseUser, additionalData: { displayName?: string; role: Role; teamId?: string; teamIds?: string[] }) => {
    if (!userAuth) return;

    const userDocRef = doc(db, 'users', userAuth.uid);
    const snapshot = await getDoc(userDocRef);

    if (!snapshot.exists()) {
        const { email } = userAuth;
        const { displayName, role, teamId } = additionalData;
        const createdAt = serverTimestamp();

        let initialTeamIds: string[] = additionalData.teamIds || [];
        if (initialTeamIds.length === 0 && teamId) {
            initialTeamIds = [teamId];
        }

        if (role === 'admin') {
            await assertSingleAdminConstraint(userAuth.uid);
        }

        await setDoc(userDocRef, {
            displayName: userAuth.displayName || displayName,
            email,
            createdAt,
            role,
            teamId: teamId || null,
            teamIds: initialTeamIds
        });
    }
    return userDocRef;
};

export const getUserDocument = async (uid: string): Promise<UserData | null> => {
    if (!uid) return null;
    try {
        const userDocRef = doc(db, `users/${uid}`);
        const userSnapshot = await getDoc(userDocRef);
        if (userSnapshot.exists()) {
            const data = userSnapshot.data();
            let teamIds = data.teamIds || [];
            if (!data.teamIds && data.teamId) {
                teamIds = [data.teamId];
            }
            return { uid, ...data, teamIds } as UserData;
        }
        return null;
    } catch (error) {
        console.error("Error fetching user data", error);
        return null;
    }
};

export const adminExists = async (): Promise<boolean> => {
    const q = query(collection(db, "users"), where("role", "==", "admin"), limit(1));
    const querySnapshot = await getDocs(q);
    return !querySnapshot.empty;
}

const assertSingleAdminConstraint = async (targetUid: string) => {
    const q = query(collection(db, "users"), where("role", "==", "admin"), limit(2));
    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) return;
    const hasDifferentAdmin = querySnapshot.docs.some((d) => d.id !== targetUid);
    if (hasDifferentAdmin) {
        throw new Error("single-admin-enforced");
    }
}

export const createTeam = async (teamName: string, adminId: string): Promise<Team> => {
    const teamCollectionRef = collection(db, 'teams');
    const newTeamDoc = await addDoc(teamCollectionRef, {
        name: teamName,
        ownerId: adminId,
        createdAt: serverTimestamp(),
        settings: {
            showLiveTeamStatus: true
        }
    });
    return { id: newTeamDoc.id, name: teamName, ownerId: adminId };
}

export const getTeamById = async (teamId: string): Promise<Team | null> => {
    const teamDocRef = doc(db, 'teams', teamId);
    const docSnap = await getDoc(teamDocRef);
    if (docSnap.exists()) {
        return { id: docSnap.id, ...docSnap.data() } as Team;
    }
    return null;
}

export const streamTeamsForAdmin = (adminId: string, callback: (teams: Team[]) => void) => {
    const q = query(collection(db, "teams"), where("ownerId", "==", adminId));
    return onSnapshot(q, (querySnapshot) => {
        const teams = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Team));
        callback(teams);
    }, (error) => {
        console.error("Error streaming teams:", error);
        callback([]);
    });
};

export const getAllUsers = async (): Promise<UserData[]> => {
    const usersCollectionRef = collection(db, 'users');
    const q = query(usersCollectionRef);
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => {
        const data = doc.data();
        let teamIds = data.teamIds || [];
        if (!data.teamIds && data.teamId) teamIds = [data.teamId];
        return { uid: doc.id, ...data, teamIds } as UserData;
    });
}

export const streamAllUsers = (callback: (users: UserData[]) => void) => {
    const usersCollectionRef = collection(db, 'users');
    const q = query(usersCollectionRef);
    return onSnapshot(q, (querySnapshot) => {
        const users = querySnapshot.docs.map(doc => {
            const data = doc.data();
            let teamIds = data.teamIds || [];
            if (!data.teamIds && data.teamId) teamIds = [data.teamId];
            return { uid: doc.id, ...data, teamIds } as UserData;
        });
        callback(users);
    }, (error) => {
        console.error("Error streaming all users:", error);
        callback([]);
    });
};

export const getUsersByTeam = async (teamId: string): Promise<UserData[]> => {
    const usersCollectionRef = collection(db, 'users');
    const q1 = query(usersCollectionRef, where("teamIds", "array-contains", teamId));
    const q2 = query(usersCollectionRef, where("teamId", "==", teamId));

    try {
        const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
        const usersMap = new Map<string, UserData>();
        const processDoc = (doc: any) => {
            const data = doc.data();
            let teamIds = data.teamIds || [];
            if (!data.teamIds && data.teamId) teamIds = [data.teamId];
            usersMap.set(doc.id, { uid: doc.id, ...data, teamIds } as UserData);
        };

        snap1.forEach(processDoc);
        snap2.forEach(processDoc);
        return Array.from(usersMap.values());
    } catch (error) {
        console.error("Error fetching users by team:", error);
        return [];
    }
}

export const streamUsersByTeam = (teamId: string, callback: (users: UserData[]) => void) => {
    const usersCollectionRef = collection(db, 'users');
    const qLegacy = query(usersCollectionRef, where("teamId", "==", teamId));
    const qNew = query(usersCollectionRef, where("teamIds", "array-contains", teamId));

    let legacyUsers: UserData[] = [];
    let newUsers: UserData[] = [];

    const emit = () => {
        const merged = new Map<string, UserData>();
        legacyUsers.forEach(u => merged.set(u.uid, u));
        newUsers.forEach(u => merged.set(u.uid, u));
        callback(Array.from(merged.values()));
    };

    const unsubLegacy = onSnapshot(qLegacy, (snap) => {
        legacyUsers = snap.docs.map(doc => {
            const data = doc.data();
            let teamIds = data.teamIds || [];
            if (!data.teamIds && data.teamId) teamIds = [data.teamId];
            return { uid: doc.id, ...data, teamIds } as UserData;
        });
        emit();
    });

    const unsubNew = onSnapshot(qNew, (snap) => {
        newUsers = snap.docs.map(doc => {
            const data = doc.data();
            let teamIds = data.teamIds || [];
            if (!data.teamIds && data.teamId) teamIds = [data.teamId];
            return { uid: doc.id, ...data, teamIds } as UserData;
        });
        emit();
    });

    return () => {
        unsubLegacy();
        unsubNew();
    };
};

export const updateUser = async (uid: string, data: Partial<UserData>) => {
    if (data?.role === 'admin') {
        await assertSingleAdminConstraint(uid);
    }
    const userDocRef = doc(db, 'users', uid);
    await updateDoc(userDocRef, data);
}

// --- Time Tracking Core Logic (Rule N1) ---

const getDocMillis = (d: any) => {
    const val = d.startTime || d.date;
    if (val && typeof val.toMillis === 'function') return val.toMillis();
    if (val && val.toDate) return val.toDate().getTime();
    return 0;
};

type RawActivityEntry = {
    type?: string;
    startTime?: any;
    endTime?: any;
    cause?: string;
};

const cloneActivityEntries = (raw: any): RawActivityEntry[] => (
    Array.isArray(raw) ? raw.map((entry: RawActivityEntry) => ({ ...entry })) : []
);

const closeLatestActivityEntry = (raw: any, endTime: any): RawActivityEntry[] => {
    const activities = cloneActivityEntries(raw);
    if (!activities.length) return activities;
    const lastIndex = activities.length - 1;
    const last = { ...activities[lastIndex] };
    if (!last.endTime) {
        last.endTime = endTime;
        activities[lastIndex] = last;
    }
    return activities;
};

const appendActivityEntry = (raw: any, entry: RawActivityEntry): RawActivityEntry[] => {
    const activities = cloneActivityEntries(raw);
    activities.push(entry);
    return activities;
};

/**
 * Creates a WorkLog ID based strictly on the local date of clock-in.
 * ID format: uid-YYYY-MM-DD
 */
export const createSessionLogId = (uid: string, date: Date | string): string => {
    const dateStr = typeof date === 'string'
        ? date
        : (() => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        })();
    return `${uid}-${dateStr}`;
};

/**
 * Fetches the SINGLE active worklog for a user, if one exists.
 */
export const getActiveWorkLog = async (uid: string): Promise<WorkLog | null> => {
    const logsRef = collection(db, 'worklogs');
    const q = query(
        logsRef,
        where("userId", "==", uid),
        where("status", "in", ["working", "on_break", "break"])
    );

    const snapshot = await getDocs(q);
    if (!snapshot.empty) {
        const docs = snapshot.docs;
        // If multiple (zombies), pick the most recent start time
        docs.sort((a, b) => {
            return getDocMillis(b.data()) - getDocMillis(a.data());
        });
        return { ...docs[0].data(), id: docs[0].id } as WorkLog;
    }
    return null;
};

/**
 * Streams the active log. If no active log, returns null.
 */
export const streamActiveWorkLog = (uid: string, callback: (log: WorkLog | null) => void) => {
    const logsRef = collection(db, 'worklogs');
    // We just care if there is ANY active status.
    const q = query(
        logsRef,
        where("userId", "==", uid),
        where("status", "in", ["working", "on_break", "break"])
    );

    return onSnapshot(q, (snapshot) => {
        if (!snapshot.empty) {
            const docs = snapshot.docs;
            docs.sort((a, b) => getDocMillis(b.data()) - getDocMillis(a.data()));

            const doc = docs[0];
            const data = doc.data();
            const rawStatus = data.status;
            const normalizedStatus = rawStatus === 'break' ? 'on_break' : rawStatus;
            callback({ id: doc.id, ...data, status: normalizedStatus } as WorkLog);
        } else {
            callback(null);
        }
    }, (error) => {
        console.error("Error streaming active log:", error);
        callback(null);
    });
};

/**
 * Manually force-close a specific log.
 */
export const forceCloseLog = async (logId: string, endTime: Date) => {
    const ref = doc(db, 'worklogs', logId);
    const snapshot = await getDoc(ref);
    const endTimestamp = Timestamp.fromDate(endTime);

    let activitiesUpdate: RawActivityEntry[] | undefined;
    if (snapshot.exists()) {
        const rawActivities = (snapshot.data() as any)?.activities;
        if (Array.isArray(rawActivities)) {
            activitiesUpdate = closeLatestActivityEntry(rawActivities, endTimestamp);
        }
    }

    const payload: Record<string, any> = {
        status: 'clocked_out',
        clockOutTime: endTimestamp,
        lastEventTimestamp: serverTimestamp()
    };

    if (activitiesUpdate) {
        payload.activities = activitiesUpdate;
    }

    await updateDoc(ref, payload);
};

/**
 * CLOCK IN: Strict N1 Implementation.
 * 1. Identify Today's Log ID (uid-YYYY-MM-DD).
 * 2. Check for ANY existing active logs.
 * 3. If active log exists AND ID != Today's ID -> It's a zombie/forgotten session. Close it.
 * 4. Create or Resume Today's Log.
 */
export const performClockIn = async (uid: string, teamId: string, userDisplayName: string) => {
    const timezone = await readOrganizationTimezone();
    const nowZoned = DateTime.now().setZone(timezone, { keepLocalTime: false });
    const now = nowZoned.toJSDate();
    const todayString = nowZoned.toISODate();
    if (!todayString) {
        throw new Error('Unable to resolve organization-local date');
    }
    const todayLogId = createSessionLogId(uid, todayString);
    const todayStartTs = Timestamp.fromDate(new Date(nowZoned.startOf('day').toMillis()));

    // 1. Check for existing active session (Zombie Check)
    const activeLog = await getActiveWorkLog(uid);

    if (activeLog) {
        if (activeLog.id === todayLogId) {
            console.log("User already clocked in for today. Resuming...");
            // Ensure status is working
            if (activeLog.status !== 'working') {
                await updateWorkLog(activeLog.id, { status: 'working', lastEventTimestamp: serverTimestamp() });
                await updateAgentStatus(uid, 'online');
            }
            return;
        } else {
            // User has an active log from a DIFFERENT day. 
            // Since they are clocking in NOW (manual action), the old one is a zombie.
            console.log(`Closing stale/zombie session from previous day: ${activeLog.id}`);
            // Close it at the current time (or midnight of that day if we want to be strict, but current time captures the error better)
            // Let's use 'now' to capture the full zombie duration, but capped logic happens elsewhere.
            // Actually, for N1, we just close it.
            await forceCloseLog(activeLog.id, now);
        }
    }

    // 2. Calculate Schedule Info for TODAY
    let scheduledStart: string | undefined;
    let scheduledEnd: string | undefined;
    let isOvernightShift = false;
    let lateMinutes = 0;

    try {
        const monthlySchedule = await getScheduleForMonth(teamId, nowZoned.year, nowZoned.month);
        const userSchedule = monthlySchedule[uid];
        const todayShift = userSchedule ? userSchedule[todayString] : null;

        if (todayShift && typeof todayShift === 'object' && 'startTime' in todayShift) {
            scheduledStart = todayShift.startTime;
            scheduledEnd = todayShift.endTime;

            if (scheduledEnd && scheduledStart && scheduledEnd < scheduledStart) {
                isOvernightShift = true;
            }

            if (scheduledStart) {
                lateMinutes = calculateLateMinutesForDateTime(scheduledStart, nowZoned, isOvernightShift);
            }
        }
    } catch (e) {
        console.error("Error calculating schedule info:", e);
    }

    // 3. Create/Update Today's Log
    const newLogRef = doc(db, 'worklogs', todayLogId);

    const logData: any = {
        userId: uid,
        userDisplayName,
        teamId,
        date: todayStartTs,
        status: 'working',
        lastEventTimestamp: serverTimestamp(),
        scheduledStart: scheduledStart || null,
        scheduledEnd: scheduledEnd || null,
        isOvernightShift: isOvernightShift,
        lateMinutes: lateMinutes
    };

    // Only set start times if creating new
    const docSnap = await getDoc(newLogRef);
    if (!docSnap.exists()) {
        logData.startTime = serverTimestamp();
        logData.clockInTime = serverTimestamp();
        logData.totalWorkSeconds = 0;
        logData.totalBreakSeconds = 0;
        logData.breaks = [];
        const initialActivityStart = Timestamp.now();
        logData.activities = [{
            type: 'working',
            startTime: initialActivityStart,
            endTime: null
        }];
    } else {
        // Just resuming today's session if it was previously clocked out (re-entry)
        // Or if we came here after closing a zombie but today's log already existed (rare)
        const existing = docSnap.data();
        if (!existing.clockInTime) logData.clockInTime = serverTimestamp();
        logData.clockOutTime = deleteField();
        logData.status = 'working';
        logData.lastEventTimestamp = serverTimestamp();
        const resumeActivityTs = Timestamp.now();
        let activities = closeLatestActivityEntry(existing.activities || [], resumeActivityTs);
        activities = appendActivityEntry(activities, {
            type: 'working',
            startTime: resumeActivityTs,
            endTime: null
        });
        logData.activities = activities;
    }

    Object.keys(logData).forEach(key => logData[key] === undefined && delete logData[key]);

    await setDoc(newLogRef, logData, { merge: true });

    // If an admin previously issued a force logout while the desktop was offline,
    // the request fields can remain stuck and keep the desktop presence showing offline.
    // Clear force-logout metadata on a successful clock-in.
    await updateAgentStatus(uid, 'online', {
        forceLogoutRequestId: deleteField(),
        forceLogoutRequestedAt: deleteField(),
        forceLogoutRequestedBy: deleteField(),
        forceLogoutCompletedAt: deleteField()
    });
};

/**
 * CLOCK OUT:
 * Finds the ACTIVE log (regardless of date) and closes it.
 */
export const performClockOut = async (uid: string) => {
    const activeLog = await getActiveWorkLog(uid);
    if (!activeLog) {
        console.warn("No active log found to clock out.");
        return;
    }

    const logDocRef = doc(db, 'worklogs', activeLog.id);

    // Use Timestamp.now() for consistent time source with other Firebase timestamps.
    // While this still uses the client clock, it's consistent with activity timestamps
    // in the same session. The display layer recalculates from clockIn/clockOut for accuracy.
    const nowTs = Timestamp.now();
    const nowMillis = nowTs.toMillis();

    let workDuration = 0;
    let breakDuration = 0;

    const getMillis = (ts: any) => (ts?.toMillis ? ts.toMillis() : (ts?.toDate ? ts.toDate().getTime() : nowMillis));

    if (activeLog.lastEventTimestamp) {
        const lastTime = getMillis(activeLog.lastEventTimestamp);
        const elapsed = Math.max(0, (nowMillis - lastTime) / 1000);

        if (activeLog.status === 'working') {
            workDuration = elapsed;
        } else if (activeLog.status === 'on_break' || (activeLog.status as any) === 'break') {
            breakDuration = elapsed;
        }
    }

    let activitiesUpdate: RawActivityEntry[] | undefined;
    if (Array.isArray((activeLog as any).activities)) {
        activitiesUpdate = closeLatestActivityEntry(activeLog.activities, nowTs);
    }

    // Close any open break entries
    let breaksUpdate: any[] | undefined;
    if (Array.isArray(activeLog.breaks) && activeLog.breaks.length > 0) {
        breaksUpdate = activeLog.breaks.map((b: any, idx: number) => {
            if (idx === activeLog.breaks!.length - 1 && !b.endTime) {
                return { ...b, endTime: nowTs };
            }
            return b;
        });
    }

    const updatePayload: Record<string, any> = {
        status: 'clocked_out',
        clockOutTime: serverTimestamp(),
        totalWorkSeconds: increment(workDuration),
        totalBreakSeconds: increment(breakDuration),
        lastEventTimestamp: serverTimestamp(),
    };

    if (activitiesUpdate) {
        updatePayload.activities = activitiesUpdate;
    }

    if (breaksUpdate) {
        updatePayload.breaks = breaksUpdate;
    }

    await updateDoc(logDocRef, updatePayload);

    await updateAgentStatus(uid, 'offline', {
        manualBreak: false,
        breakStartedAt: deleteField()
    });

    const userDocRef = doc(db, 'users', uid);
    await updateDoc(userDocRef, {
        isLoggedIn: false,
        activeSession: deleteField(),
        activeDesktopSessionId: deleteField(),
        activeDesktopDeviceId: deleteField(),
        activeDesktopMachineName: deleteField(),
        activeDesktopSessionStartedAt: deleteField(),
        lastClockOut: serverTimestamp(),
        sessionClearedAt: serverTimestamp()
    });
};

/**
 * CLOCK OUT (ALL ACTIVE LOGS):
 * Used for sign-out to ensure every active log for the user is closed.
 */
export const performClockOutAllActiveLogs = async (uid: string) => {
    if (!uid) return;
    const logsRef = collection(db, 'worklogs');
    const q = query(
        logsRef,
        where("userId", "==", uid),
        where("status", "in", ["working", "on_break", "break"])
    );

    const snapshot = await getDocs(q);
    if (snapshot.empty) {
        console.warn("No active logs found to clock out.");
        return;
    }

    const nowTs = Timestamp.now();
    const nowMillis = nowTs.toMillis();
    const getMillis = (ts: any) => (ts?.toMillis ? ts.toMillis() : (ts?.toDate ? ts.toDate().getTime() : nowMillis));

    const updatePromises = snapshot.docs.map(async (docSnap) => {
        const data = docSnap.data() as any;

        let workDuration = 0;
        let breakDuration = 0;

        if (data.lastEventTimestamp) {
            const lastTime = getMillis(data.lastEventTimestamp);
            const elapsed = Math.max(0, (nowMillis - lastTime) / 1000);

            if (data.status === 'working') {
                workDuration = elapsed;
            } else if (data.status === 'on_break' || data.status === 'break') {
                breakDuration = elapsed;
            }
        }

        let activitiesUpdate: RawActivityEntry[] | undefined;
        if (Array.isArray(data.activities)) {
            activitiesUpdate = closeLatestActivityEntry(data.activities, nowTs);
        }

        let breaksUpdate: any[] | undefined;
        if (Array.isArray(data.breaks) && data.breaks.length > 0) {
            breaksUpdate = data.breaks.map((b: any, idx: number) => {
                if (idx === data.breaks.length - 1 && !b.endTime) {
                    return { ...b, endTime: nowTs };
                }
                return b;
            });
        }

        const updatePayload: Record<string, any> = {
            status: 'clocked_out',
            clockOutTime: serverTimestamp(),
            totalWorkSeconds: increment(workDuration),
            totalBreakSeconds: increment(breakDuration),
            lastEventTimestamp: serverTimestamp(),
        };

        if (activitiesUpdate) updatePayload.activities = activitiesUpdate;
        if (breaksUpdate) updatePayload.breaks = breaksUpdate;

        await updateDoc(docSnap.ref, updatePayload);
    });

    await Promise.all(updatePromises);

    await updateAgentStatus(uid, 'offline', {
        manualBreak: false,
        breakStartedAt: deleteField()
    });

    const userDocRef = doc(db, 'users', uid);
    await updateDoc(userDocRef, {
        isLoggedIn: false,
        activeSession: deleteField(),
        activeDesktopSessionId: deleteField(),
        activeDesktopDeviceId: deleteField(),
        activeDesktopMachineName: deleteField(),
        activeDesktopSessionStartedAt: deleteField(),
        lastClockOut: serverTimestamp(),
        sessionClearedAt: serverTimestamp()
    });
};

export const updateWorkLog = async (logId: string, data: object) => {
    const logDocRef = doc(db, 'worklogs', logId);
    await updateDoc(logDocRef, data);
};

// --- Dashboard Data Streaming ---

/**
 * Streams logs for the dashboard.
 * MUST return:
 * 1. Logs started TODAY.
 * 2. Logs started YESTERDAY (or earlier) that are STILL ACTIVE.
 * This creates the "Single Continuous Session" view on the dashboard.
 */
export const streamTodayWorkLogs = (callback: (logs: WorkLog[]) => void, teamId?: string) => {
    const logsRef = collection(db, "worklogs");

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayTimestamp = Timestamp.fromDate(startOfToday);

    // Query A: Started Today (Active OR Closed)
    const qToday = query(
        logsRef,
        where("date", ">=", startOfTodayTimestamp)
    );

    // Query B: Currently Active (Started anytime)
    // Note: This might return docs already in qToday, we must dedupe.
    const qActive = query(
        logsRef,
        where("status", "in", ["working", "on_break", "break"])
    );

    let todayLogs: WorkLog[] = [];
    let activeLogs: WorkLog[] = [];

    const emit = () => {
        const merged = new Map<string, WorkLog>();

        // Add active logs first
        activeLogs.forEach(log => merged.set(log.id, log));
        // Overwrite/Add today's logs (ensures we get closed ones from today too)
        todayLogs.forEach(log => merged.set(log.id, log));

        let result = Array.from(merged.values());
        if (teamId) {
            result = result.filter(log => log.teamId === teamId);
        }

        // Sort: Active first, then by name
        result.sort((a, b) => {
            const aActive = a.status !== 'clocked_out';
            const bActive = b.status !== 'clocked_out';
            if (aActive && !bActive) return -1;
            if (!aActive && bActive) return 1;
            return a.userDisplayName.localeCompare(b.userDisplayName);
        });

        callback(result);
    };

    const unsubToday = onSnapshot(qToday, (snap) => {
        todayLogs = snap.docs.map(doc => {
            const data = doc.data();
            const rawStatus = data.status;
            const normalizedStatus = rawStatus === 'break' ? 'on_break' : rawStatus;
            return { id: doc.id, ...data, status: normalizedStatus } as WorkLog;
        });
        emit();
    });

    const unsubActive = onSnapshot(qActive, (snap) => {
        activeLogs = snap.docs.map(doc => {
            const data = doc.data();
            const rawStatus = data.status;
            const normalizedStatus = rawStatus === 'break' ? 'on_break' : rawStatus;
            return { id: doc.id, ...data, status: normalizedStatus } as WorkLog;
        });
        emit();
    });

    return () => {
        unsubToday();
        unsubActive();
    };
};

export const streamWorkLogsForDate = (dateString: string, callback: (logs: WorkLog[]) => void, teamId?: string) => {
    const startOfDay = new Date(dateString);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(dateString);
    endOfDay.setHours(23, 59, 59, 999);

    const startTs = Timestamp.fromDate(startOfDay);
    const endTs = Timestamp.fromDate(endOfDay);

    const logsRef = collection(db, "worklogs");

    const q = query(
        logsRef,
        where("date", ">=", startTs),
        where("date", "<=", endTs)
    );

    return onSnapshot(q, (snap) => {
        const logs = snap.docs.map(doc => {
            const data = doc.data();
            const rawStatus = data.status;
            const normalizedStatus = rawStatus === 'break' ? 'on_break' : rawStatus;
            return { id: doc.id, ...data, status: normalizedStatus } as WorkLog;
        });

        if (teamId) {
            callback(logs.filter(l => l.teamId === teamId));
        } else {
            callback(logs);
        }
    });
};

export const getWorkLogsForDateRange = async (teamId: string, startDate: Date, endDate: Date): Promise<WorkLog[]> => {
    const logsCollectionRef = collection(db, 'worklogs');
    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);

    const q = query(
        logsCollectionRef,
        where("teamId", "==", teamId),
        where("date", ">=", startTs),
        where("date", "<=", endTs)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => {
        const data = doc.data();
        const rawStatus = data.status;
        const normalizedStatus = rawStatus === 'break' ? 'on_break' : rawStatus;
        return { id: doc.id, ...data, status: normalizedStatus || 'clocked_out' } as WorkLog;
    });
};

// --- Helpers for Stale/Zombie Handling ---

export const isSessionStale = (log: WorkLog): boolean => {
    // Logic: If user hasn't pinged in > 4 hours (zombie) OR is from previous day and not overnight
    if (!log.lastEventTimestamp) return false;

    const now = Date.now();
    const lastTime = (log.lastEventTimestamp as any).toMillis ? (log.lastEventTimestamp as any).toMillis() : (log.lastEventTimestamp as any).toDate().getTime();
    const diffHours = (now - lastTime) / (1000 * 60 * 60);

    if (diffHours > 4) return true; // Zombie detection

    return false;
};

export const closeStaleSession = async (log: WorkLog) => {
    console.log("Closing stale session:", log.id);
    // Use lastEventTimestamp as the cut-off
    await forceCloseLog(log.id, (log.lastEventTimestamp as any).toDate());
    await updateAgentStatus(log.userId, 'offline');
};

// --- Scheduling & Admin (Existing) ---

export const getScheduleForMonth = async (teamId: string, year: number, month: number): Promise<MonthlySchedule> => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const scheduleDocRef = doc(db, 'schedules', `${teamId}-${monthStr}`);
    const docSnap = await getDoc(scheduleDocRef);
    if (docSnap.exists()) {
        return docSnap.data() as MonthlySchedule;
    }
    return {};
}

export const streamScheduleForMonth = (teamId: string, year: number, month: number, callback: (schedule: MonthlySchedule) => void) => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const scheduleDocRef = doc(db, 'schedules', `${teamId}-${monthStr}`);
    const unsubscribe = onSnapshot(scheduleDocRef, (docSnap) => {
        if (docSnap.exists()) callback(docSnap.data() as MonthlySchedule);
        else callback({});
    }, (error) => {
        console.error("Error streaming schedule:", error);
        callback({});
    });
    return unsubscribe;
};

const isShiftEntryObject = (entry: ShiftEntry | undefined): entry is ShiftTime => {
    return Boolean(entry && typeof entry === 'object' && 'startTime' in entry);
};

const normalizeShiftKey = (entry: ShiftEntry | undefined): string => {
    if (!isShiftEntryObject(entry)) return '__NO_SHIFT__';
    return `${entry.startTime}|${entry.endTime}`;
};

const getDateFromTimestampLike = (value: any): Date | null => {
    if (!value) return null;
    try {
        if (value instanceof Timestamp) return value.toDate();
        if (typeof value.toDate === 'function') return value.toDate();
        if (value instanceof Date) return value;
        return new Date(value);
    } catch {
        return null;
    }
};

const OVERNIGHT_THRESHOLD_MINUTES = 12 * 60;

const calculateLateMinutesForDateTime = (
    shiftStart: string,
    dateTime: DateTime | null,
    isOvernightShift = false
): number => {
    if (!shiftStart || !dateTime) return 0;
    const [hour, minute] = shiftStart.split(':').map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return 0;
    const scheduledSameDay = dateTime.set({ hour, minute, second: 0, millisecond: 0 });

    if (dateTime < scheduledSameDay) {
        if (!isOvernightShift) return 0;
        const leadMinutes = scheduledSameDay.diff(dateTime, 'minutes').minutes;
        if (leadMinutes <= OVERNIGHT_THRESHOLD_MINUTES) return 0;
        const previousDayStart = scheduledSameDay.minus({ days: 1 });
        return Math.max(0, dateTime.diff(previousDayStart, 'minutes').minutes);
    }

    return Math.max(0, dateTime.diff(scheduledSameDay, 'minutes').minutes);
};

const computeLateMinutes = (
    shiftStart: string,
    clockIn: Timestamp | null | undefined,
    timezone: string,
    isOvernightShift = false
): number => {
    if (!shiftStart || !clockIn) return 0;
    const clockInDate = getDateFromTimestampLike(clockIn);
    if (!clockInDate) return 0;
    const zoned = DateTime.fromJSDate(clockInDate).setZone(timezone, { keepLocalTime: false });
    return calculateLateMinutesForDateTime(shiftStart, zoned, isOvernightShift);
};

const computeIsOvernightShift = (entry: ShiftEntry | undefined): boolean => {
    if (!isShiftEntryObject(entry)) return false;
    if (!entry.endTime) return false;
    return entry.endTime < entry.startTime;
};

const persistAutoClockSlot = async (userId: string, date: string, entry: ShiftEntry | undefined, timezone: string) => {
    const ref = doc(db, 'autoClockConfigs', userId);
    if (isShiftEntryObject(entry)) {
        const slot = {
            shiftStartTime: entry.startTime,
            shiftEndTime: entry.endTime ?? null,
            isOvernightShift: computeIsOvernightShift(entry),
            timezone
        };
        await setDoc(ref, { [date]: slot }, { merge: true });
    } else {
        await setDoc(ref, { [date]: deleteField() }, { merge: true });
    }
};

const collectChangedScheduleSlots = (previous: MonthlySchedule | undefined, next: MonthlySchedule) => {
    const changes: Array<{ userId: string; date: string; entry: ShiftEntry | undefined }> = [];
    const userIds = new Set([
        ...Object.keys(previous || {}),
        ...Object.keys(next || {})
    ]);

    userIds.forEach((userId) => {
        const prevDays = previous?.[userId] || {};
        const nextDays = next?.[userId] || {};
        const dates = new Set([
            ...Object.keys(prevDays),
            ...Object.keys(nextDays)
        ]);

        dates.forEach((date) => {
            const prevEntry = prevDays[date];
            const nextEntry = nextDays[date];
            if (normalizeShiftKey(prevEntry) !== normalizeShiftKey(nextEntry)) {
                changes.push({ userId, date, entry: nextEntry });
            }
        });
    });

    return changes;
};

const recalculateLateMinutesForSlot = async (userId: string, date: string, entry: ShiftEntry | undefined, timezone: string) => {
    const logId = `${userId}-${date}`;
    const logRef = doc(db, 'worklogs', logId);
    const snapshot = await getDoc(logRef);
    if (!snapshot.exists()) return;
    const logData = snapshot.data() as WorkLog;
    const updates: Record<string, any> = {};
    if (isShiftEntryObject(entry)) {
        const overnight = computeIsOvernightShift(entry);
        updates.scheduledStart = entry.startTime;
        updates.scheduledEnd = entry.endTime ?? null;
        updates.lateMinutes = computeLateMinutes(
            entry.startTime,
            logData.clockInTime as Timestamp | undefined,
            timezone,
            overnight
        );
        updates.isOvernightShift = overnight;
    } else {
        updates.scheduledStart = null;
        updates.scheduledEnd = null;
        updates.lateMinutes = 0;
        updates.isOvernightShift = false;
    }
    await updateDoc(logRef, updates);
};

const reconcileLateMinutesForScheduleChanges = async (previous: MonthlySchedule | undefined, next: MonthlySchedule, timezone: string) => {
    const changes = collectChangedScheduleSlots(previous, next);
    for (const change of changes) {
        await recalculateLateMinutesForSlot(change.userId, change.date, change.entry, timezone);
        await persistAutoClockSlot(change.userId, change.date, change.entry, timezone);
    }
};

export const updateScheduleForMonth = async (
    teamId: string,
    year: number,
    month: number,
    scheduleData: MonthlySchedule,
    options: { timezone?: string } = {}
) => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const scheduleDocRef = doc(db, 'schedules', `${teamId}-${monthStr}`);
    const previousSnapshot = await getDoc(scheduleDocRef);
    const previousData = previousSnapshot.exists() ? (previousSnapshot.data() as MonthlySchedule) : undefined;
    await setDoc(scheduleDocRef, scheduleData, { merge: true });
    const timezone = options.timezone || await readOrganizationTimezone();
    await reconcileLateMinutesForScheduleChanges(previousData, scheduleData, timezone);
}

export const streamGlobalAdminSettings = (callback: (settings: AdminSettingsType | null) => void) => {
    const settingsRef = doc(db, 'adminSettings', 'global');
    return onSnapshot(settingsRef, (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data() as AdminSettingsType;
            callback({
                ...data,
                organizationTimezone: data.organizationTimezone || DEFAULT_ORGANIZATION_TIMEZONE
            });
        } else {
            callback(null);
        }
    }, (error) => console.error("Error streaming global settings:", error));
};

export const updateGlobalAdminSettings = async (settings: Partial<AdminSettingsType>) => {
    const settingsRef = doc(db, 'adminSettings', 'global');
    const payload: Partial<AdminSettingsType> = { ...settings };
    if (Object.prototype.hasOwnProperty.call(payload, 'organizationTimezone')) {
        if (!payload.organizationTimezone) {
            payload.organizationTimezone = DEFAULT_ORGANIZATION_TIMEZONE;
        }
    }
    await setDoc(settingsRef, payload, { merge: true });
};

export const updateAgentStatus = async (uid: string, status: 'online' | 'break' | 'offline', additionalData: Record<string, any> = {}) => {
    const docRef = doc(db, 'agentStatus', uid);
    await setDoc(docRef, {
        status,
        lastUpdate: serverTimestamp(),
        ...additionalData
    }, { merge: true });
};

export const streamAllAgentStatuses = (callback: (statuses: Record<string, any>) => void) => {
    const q = query(collection(db, "agentStatus"));
    return onSnapshot(q, (snapshot) => {
        const statuses: Record<string, any> = {};
        snapshot.docs.forEach(doc => statuses[doc.id] = doc.data());
        callback(statuses);
    });
};

const createForceLogoutRequestId = () => `flr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createReconnectRequestId = () => `rcr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

export const sendCommandToDesktop = async (
    uid: string,
    command: 'startRecording' | 'stopRecording' | 'forceLogout',
    extraData: Record<string, any> = {}
) => {
    const docRef = doc(db, 'desktopCommands', uid);
    await setDoc(docRef, { [command]: true, timestamp: serverTimestamp(), ...extraData }, { merge: true });
};

export const requestDesktopReconnect = async (uid: string) => {
    if (!uid) return;
    const reconnectRequestId = createReconnectRequestId();
    const docRef = doc(db, 'desktopCommands', uid);
    await setDoc(docRef, { reconnectRequestId, timestamp: serverTimestamp() }, { merge: true });
    return reconnectRequestId;
};

export const forceLogoutAgent = async (uid: string) => {
    if (!uid) return;

    const forceLogoutRequestId = createForceLogoutRequestId();

    // IMPORTANT: Read targetDesktopSessionId BEFORE performClockOut clears it!
    // Otherwise the session targeting will fail and Electron will ignore the command.
    let targetDesktopSessionId: string | null = null;
    try {
        const userSnap = await getDoc(doc(db, 'users', uid));
        const data = userSnap.exists() ? (userSnap.data() as any) : null;
        targetDesktopSessionId = data?.activeDesktopSessionId ? String(data.activeDesktopSessionId) : null;
    } catch (_) {
        // ignore
    }

    try {
        await setDoc(doc(db, 'agentStatus', uid), {
            forceLogoutRequestId,
            forceLogoutRequestedAt: serverTimestamp(),
            forceLogoutRequestedBy: 'admin_panel'
        }, { merge: true });
    } catch (error) {
        console.error('[forceLogoutAgent] Failed to persist force logout request metadata', error);
    }

    // Note: performClockOut is called here from admin panel.
    // The Electron app ALSO calls clock-out when it receives the forceLogout command.
    // This is intentional: if Electron is offline, admin panel ensures clock-out happens.
    // If Electron is online, its clock-out will find no active log (already clocked out).
    try {
        await performClockOut(uid);
    } catch (error) {
        console.error('[forceLogoutAgent] Failed to clock out user before forcing logout', error);
    }

    // Ensure user session fields are cleared even if performClockOut failed
    try {
        const userDocRef = doc(db, 'users', uid);
        await updateDoc(userDocRef, {
            isLoggedIn: false,
            activeDesktopSessionId: deleteField(),
            activeDesktopDeviceId: deleteField(),
            activeDesktopMachineName: deleteField(),
            activeDesktopSessionStartedAt: deleteField(),
            sessionClearedAt: serverTimestamp()
        });
    } catch (error) {
        console.error('[forceLogoutAgent] Failed to clear user session fields', error);
    }

    try {
        await sendCommandToDesktop(uid, 'forceLogout', targetDesktopSessionId ? { targetDesktopSessionId } : {});
    } catch (error) {
        console.error('[forceLogoutAgent] Failed to dispatch force logout command to desktop', error);
        throw error;
    }
};

// --- Recording Logs ---

export type RecordingLogEntry = {
    id: string;
    userId: string;
    userName: string | null;
    teamId: string | null;
    fileName: string;
    status: 'success' | 'failed' | 'pending';
    uploadTarget: 'dropbox' | 'googleSheets' | 'http' | null;
    machineName: string | null;
    fileSize: number | null;
    durationMs: number | null;
    downloadUrl: string | null;
    error: string | null;
    retryCount: number;
    createdAt: any;
    uploadedAt: any;
    loggedAt: any;
};

export const streamRecordingLogs = (
    callback: (logs: RecordingLogEntry[]) => void,
    options: { teamId?: string; status?: string; limitCount?: number } = {}
) => {
    const logsRef = collection(db, 'recordingLogs');

    // Build query - order by loggedAt descending
    let q = query(logsRef, orderBy('loggedAt', 'desc'), limit(options.limitCount || 200));

    return onSnapshot(q, (snapshot) => {
        let logs = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        } as RecordingLogEntry));

        // Client-side filtering for team and status (since we can't do compound orderBy with where)
        if (options.teamId) {
            logs = logs.filter(log => log.teamId === options.teamId);
        }
        // Handle status filtering - 'failed_or_pending' excludes success logs
        if (options.status === 'failed_or_pending') {
            logs = logs.filter(log => log.status === 'failed' || log.status === 'pending');
        } else if (options.status && options.status !== 'all') {
            logs = logs.filter(log => log.status === options.status);
        }

        callback(logs);
    }, (error) => {
        console.error('[streamRecordingLogs] error:', error);
        callback([]);
    });
};

export const getRecordingLogStats = async (teamId?: string): Promise<{ success: number; failed: number; pending: number }> => {
    const logsRef = collection(db, 'recordingLogs');
    const snapshot = await getDocs(logsRef);

    let logs = snapshot.docs.map(doc => doc.data());
    if (teamId) {
        logs = logs.filter(log => log.teamId === teamId);
    }

    return {
        success: logs.filter(l => l.status === 'success').length,
        failed: logs.filter(l => l.status === 'failed').length,
        pending: logs.filter(l => l.status === 'pending').length
    };
};

/**
 * Clear all recording logs from Firestore
 * @param options - Optional filters: status ('all', 'failed', 'pending'), teamId
 */
export const clearRecordingLogs = async (options: { status?: string; teamId?: string } = {}): Promise<number> => {
    const logsRef = collection(db, 'recordingLogs');
    const snapshot = await getDocs(logsRef);

    let docsToDelete = snapshot.docs;

    // Apply filters
    if (options.teamId) {
        docsToDelete = docsToDelete.filter(doc => doc.data().teamId === options.teamId);
    }
    if (options.status && options.status !== 'all') {
        if (options.status === 'failed_or_pending') {
            docsToDelete = docsToDelete.filter(doc => {
                const status = doc.data().status;
                return status === 'failed' || status === 'pending';
            });
        } else {
            docsToDelete = docsToDelete.filter(doc => doc.data().status === options.status);
        }
    }

    // Delete in batches to avoid Firestore limits
    const batchSize = 500;
    let deletedCount = 0;

    for (let i = 0; i < docsToDelete.length; i += batchSize) {
        const batch = docsToDelete.slice(i, i + batchSize);
        await Promise.all(batch.map(doc => deleteDoc(doc.ref)));
        deletedCount += batch.length;
    }

    return deletedCount;
};

/**
 * Request a retry for a specific recording upload
 * Writes a retry command to Firestore that the desktop app will pick up
 * @param logId - The ID of the recording log entry to retry
 * @param fileName - The name of the recording file
 * @param machineName - The machine name where the file is stored
 * @param userId - The user ID who owns the recording
 */
export const requestRecordingRetry = async (
    logId: string,
    fileName: string,
    machineName: string,
    userId: string
): Promise<{ success: boolean; error?: string }> => {
    try {
        if (!logId || !fileName || !machineName || !userId) {
            return { success: false, error: 'Missing required parameters' };
        }

        // Write the retry command to recordinLogRetryCommands collection
        const commandRef = doc(db, 'recordingRetryCommands', logId);
        await setDoc(commandRef, {
            logId,
            fileName,
            machineName,
            userId,
            status: 'pending',
            requestedAt: serverTimestamp(),
            processedAt: null,
            result: null,
            error: null
        });

        return { success: true };
    } catch (error) {
        console.error('[requestRecordingRetry] error:', error);
        return { success: false, error: (error as Error).message };
    }
};

/**
 * Get the status of a retry command
 */
export const getRetryCommandStatus = async (logId: string): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'not_found';
    error?: string;
    result?: any;
}> => {
    try {
        const commandRef = doc(db, 'recordingRetryCommands', logId);
        const snap = await getDoc(commandRef);
        if (!snap.exists()) {
            return { status: 'not_found' };
        }
        const data = snap.data();
        return {
            status: data.status || 'pending',
            error: data.error || undefined,
            result: data.result || undefined
        };
    } catch (error) {
        console.error('[getRetryCommandStatus] error:', error);
        return { status: 'not_found', error: (error as Error).message };
    }
};
