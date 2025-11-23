
import { doc, setDoc, getDoc, serverTimestamp, collection, query, where, getDocs, addDoc, limit, updateDoc, Timestamp, arrayUnion, increment, onSnapshot, deleteDoc, deleteField, orderBy } from 'firebase/firestore';
import { db } from './firebase';
import type { User as FirebaseUser } from 'firebase/auth';
import type { UserData, Role, Team, WorkLog, MonthlySchedule, TeamSettings, AdminSettings, ShiftTime } from '../types';

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

    try {
      await setDoc(userDocRef, {
        displayName: userAuth.displayName || displayName,
        email,
        createdAt,
        role,
        teamId: teamId || null,
        teamIds: initialTeamIds
      });
    } catch (error) {
      console.error("Error creating user document: ", error);
    }
  }
  return userDocRef;
};

export const getUserDocument = async (uid: string): Promise<UserData | null> => {
  if (!uid) return null;
  try {
    const userDocRef = doc(db, `users/${uid}`);
    const userSnapshot = await getDoc(userDocRef);
    if(userSnapshot.exists()){
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

export const updateTeamSettings = async (teamId: string, settings: Partial<TeamSettings>) => {
    const teamDocRef = doc(db, 'teams', teamId);
    await updateDoc(teamDocRef, { settings });
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

/**
 * Creates a WorkLog ID based strictly on the local date of clock-in.
 * ID format: uid-YYYY-MM-DD
 */
export const createSessionLogId = (uid: string, date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
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
    await updateDoc(ref, {
        status: 'clocked_out',
        clockOutTime: Timestamp.fromDate(endTime),
        lastEventTimestamp: serverTimestamp()
    });
};

/**
 * CLOCK IN: Strict N1 Implementation.
 * 1. Identify Today's Log ID (uid-YYYY-MM-DD).
 * 2. Check for ANY existing active logs.
 * 3. If active log exists AND ID != Today's ID -> It's a zombie/forgotten session. Close it.
 * 4. Create or Resume Today's Log.
 */
export const performClockIn = async (uid: string, teamId: string, userDisplayName: string) => {
    const now = new Date();
    const todayLogId = createSessionLogId(uid, now);
    const todayStartTs = Timestamp.fromDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));

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
        const todayString = now.toISOString().split('T')[0];
        const [y, m] = todayString.split('-').map(Number);
        const monthlySchedule = await getScheduleForMonth(teamId, y, m);
        const userSchedule = monthlySchedule[uid];
        const todayShift = userSchedule ? userSchedule[todayString] : null;

        if (todayShift && typeof todayShift === 'object' && 'startTime' in todayShift) {
            scheduledStart = todayShift.startTime;
            scheduledEnd = todayShift.endTime;
            
            if (scheduledEnd < scheduledStart) {
                isOvernightShift = true;
            }

            const [hh, mm] = scheduledStart.split(':').map(Number);
            const startMins = hh * 60 + mm;
            const currentMins = now.getHours() * 60 + now.getMinutes();
            if (currentMins > startMins) {
                lateMinutes = currentMins - startMins;
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
    } else {
        // Just resuming today's session if it was previously clocked out (re-entry)
        // Or if we came here after closing a zombie but today's log already existed (rare)
        const existing = docSnap.data();
        if (!existing.clockInTime) logData.clockInTime = serverTimestamp();
    }

    Object.keys(logData).forEach(key => logData[key] === undefined && delete logData[key]);

    await setDoc(newLogRef, logData, { merge: true });
    await updateAgentStatus(uid, 'online');
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
    const now = Date.now();
    
    let workDuration = 0;
    let breakDuration = 0;
    
    const getMillis = (ts: any) => (ts?.toMillis ? ts.toMillis() : (ts?.toDate ? ts.toDate().getTime() : Date.now()));

    if (activeLog.lastEventTimestamp) {
        const lastTime = getMillis(activeLog.lastEventTimestamp);
        const elapsed = (now - lastTime) / 1000;
        
        if (activeLog.status === 'working') {
            workDuration = elapsed;
        } else if (activeLog.status === 'on_break' || (activeLog.status as any) === 'break') {
            breakDuration = elapsed;
        }
    }

    await updateDoc(logDocRef, {
        status: 'clocked_out',
        clockOutTime: serverTimestamp(),
        totalWorkSeconds: increment(workDuration),
        totalBreakSeconds: increment(breakDuration),
        lastEventTimestamp: serverTimestamp(),
    });

    await updateAgentStatus(uid, 'offline', {
        manualBreak: false,
        breakStartedAt: deleteField()
    });

    const userDocRef = doc(db, 'users', uid);
    await updateDoc(userDocRef, {
        isLoggedIn: false,
        activeSession: deleteField(),
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

export const updateScheduleForMonth = async (teamId: string, year: number, month: number, scheduleData: MonthlySchedule) => {
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;
    const scheduleDocRef = doc(db, 'schedules', `${teamId}-${monthStr}`);
    await setDoc(scheduleDocRef, scheduleData, { merge: true });
}

export const streamGlobalAdminSettings = (callback: (settings: AdminSettings | null) => void) => {
    const settingsRef = doc(db, 'adminSettings', 'global');
    return onSnapshot(settingsRef, (docSnap) => {
        if (docSnap.exists()) {
            callback(docSnap.data() as AdminSettings);
        } else {
            callback(null);
        }
    }, (error) => console.error("Error streaming global settings:", error));
};

export const updateGlobalAdminSettings = async (settings: Partial<AdminSettings>) => {
    const settingsRef = doc(db, 'adminSettings', 'global');
    await setDoc(settingsRef, settings, { merge: true });
};

export const updateAgentAutoClockOut = async (uid: string, config: { enabled: boolean, shiftEndTime: string }) => {
    const docRef = doc(db, 'adminSettings', 'agents');
    await setDoc(docRef, { [uid]: { autoClockOut: config } }, { merge: true });
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

export const sendCommandToDesktop = async (uid: string, command: 'startRecording' | 'stopRecording') => {
    const docRef = doc(db, 'desktopCommands', uid);
    await setDoc(docRef, { [command]: true, timestamp: serverTimestamp() }, { merge: true });
};
