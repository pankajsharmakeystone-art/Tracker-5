
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";

admin.initializeApp();
const db = admin.firestore();

/**
 * Daily Midnight Cleanup (Rule N1 Compliant)
 * Runs at 00:05.
 * 
 * Goal: Close non-overnight sessions from previous days that were forgotten.
 * CRITICAL: Do NOT close sessions marked as `isOvernightShift: true`.
 */
export const dailyMidnightCleanup = onSchedule("5 0 * * *", async (event) => {
    console.log("Starting daily midnight cleanup...");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = admin.firestore.Timestamp.fromDate(today);

    // Find stale active logs started before today
    const snapshot = await db.collection("worklogs")
      .where("status", "in", ["working", "on_break", "break"])
      .where("date", "<", todayTs)
      .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    let count = 0;

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      
      // Rule N1 Exception: Overnight shifts are allowed to cross midnight.
      // They will be closed by `autoClockOutAtShiftEnd` or manual action.
      if (data.isOvernightShift === true) {
          console.log(`Skipping overnight shift: ${doc.id}`);
          return; 
      }

      console.log(`Force closing non-overnight stale log ${doc.id}`);
      
      // Close effectively at 23:59:59 of the start date
      const logDate = data.date.toDate();
      const endOfDay = new Date(logDate);
      endOfDay.setHours(23, 59, 59, 999);

      batch.update(db.collection("worklogs").doc(doc.id), {
        status: "clocked_out",
        clockOutTime: admin.firestore.Timestamp.fromDate(endOfDay),
        lastEventTimestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      batch.update(db.collection("agentStatus").doc(data.userId), {
        status: "offline",
        manualBreak: false,
        breakStartedAt: admin.firestore.FieldValue.delete()
      });
      
      batch.update(db.collection("users").doc(data.userId), {
        isLoggedIn: false,
        activeSession: admin.firestore.FieldValue.delete()
      });

      count++;
    });

    if (count > 0) {
      await batch.commit();
      console.log(`Closed ${count} stale non-overnight sessions.`);
    }

    return null;
  });


/**
 * Auto Clock-Out at Shift End
 * Enforces schedule limits.
 */
export const autoClockOutAtShiftEnd = onSchedule("every 5 minutes", async (event) => {
      const now = new Date();
      const snapshot = await db.collection("worklogs")
        .where("status", "in", ["working", "on_break", "break"])
        .get();
      
      const batch = db.batch();
      let count = 0;
      
      const parseTime = (dateObj: Date, timeStr: string) => {
          const [hh, mm] = timeStr.split(":").map(Number);
          const newDate = new Date(dateObj);
          newDate.setHours(hh, mm, 0, 0);
          return newDate;
      };

      snapshot.docs.forEach((doc) => {
          const data = doc.data();
          if (!data.scheduledEnd || !data.date) return;

          let shiftEndDate: Date;
          const logStartDate = data.date.toDate();

          // Correctly calculate end time based on shift type
          if (data.isOvernightShift) {
              const nextDay = new Date(logStartDate);
              nextDay.setDate(nextDay.getDate() + 1);
              shiftEndDate = parseTime(nextDay, data.scheduledEnd);
          } else {
              shiftEndDate = parseTime(logStartDate, data.scheduledEnd);
          }

          // Buffer: Allow 15 mins past shift end? Strict for now.
          if (now > shiftEndDate) {
              console.log(`Auto-clocking out ${doc.id}. End: ${shiftEndDate.toISOString()}`);
              
              batch.update(db.collection("worklogs").doc(doc.id), {
                  status: "clocked_out",
                  clockOutTime: admin.firestore.Timestamp.fromDate(shiftEndDate),
                  lastEventTimestamp: admin.firestore.FieldValue.serverTimestamp()
              });

              batch.update(db.collection("agentStatus").doc(data.userId), {
                status: "offline",
                manualBreak: false,
                breakStartedAt: admin.firestore.FieldValue.delete()
              });

              batch.update(db.collection("users").doc(data.userId), {
                isLoggedIn: false,
                activeSession: admin.firestore.FieldValue.delete()
              });

              count++;
          }
      });

      if (count > 0) await batch.commit();
      return null;
  });
