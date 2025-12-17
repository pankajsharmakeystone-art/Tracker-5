import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';

function parseArgs(argv) {
  const args = {};
  for (const item of argv.slice(2)) {
    const [k, ...rest] = item.split('=');
    const key = k.replace(/^--/, '');
    const value = rest.length ? rest.join('=') : true;
    args[key] = value;
  }
  return args;
}

function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_ADMIN_SDK_JSON;
  if (inlineJson) {
    const parsed = JSON.parse(inlineJson);
    if (typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }

  const explicitPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || process.env.FIREBASE_ADMIN_SDK_PATH
    || process.env.FIREBASE_KEY_PATH
    || path.join(process.cwd(), 'firebase-service-account.json');

  if (!fs.existsSync(explicitPath)) {
    throw new Error(
      `Set FIREBASE_SERVICE_ACCOUNT_PATH (or FIREBASE_SERVICE_ACCOUNT_JSON) before running. Checked: ${explicitPath}`
    );
  }

  return JSON.parse(fs.readFileSync(explicitPath, 'utf8'));
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis());
  if (typeof value === 'number') return new Date(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deriveBreakCause(entry) {
  const raw = (entry?.cause || entry?.reason || entry?.type || entry?.source || '').toString().toLowerCase();
  if (raw.includes('idle')) return 'idle';
  if (entry?.auto === true || entry?.isIdle === true) return 'idle';
  return 'manual';
}

function computeBreakSecondsFromBreaks(worklog) {
  const breaks = Array.isArray(worklog?.breaks) ? worklog.breaks : [];
  if (breaks.length === 0) {
    return { total: null, manual: null, idle: null };
  }

  const fallbackEnd = normalizeDate(worklog.clockOutTime)
    || normalizeDate(worklog.lastEventTimestamp)
    || new Date();

  let manualSeconds = 0;
  let idleSeconds = 0;
  let accounted = false;

  for (const entry of breaks) {
    const start = normalizeDate(entry?.startTime);
    const end = normalizeDate(entry?.endTime) || fallbackEnd;
    if (!start || !end || end <= start) continue;
    accounted = true;
    const duration = (end.getTime() - start.getTime()) / 1000;
    if (deriveBreakCause(entry) === 'idle') idleSeconds += duration;
    else manualSeconds += duration;
  }

  if (!accounted) {
    return { total: 0, manual: 0, idle: 0 };
  }

  const total = Math.max(0, manualSeconds + idleSeconds);
  return { total, manual: manualSeconds, idle: idleSeconds };
}

async function main() {
  const args = parseArgs(process.argv);

  const startStr = args.start;
  const endStr = args.end;
  const teamId = typeof args.teamId === 'string' ? args.teamId : null;
  const apply = args.apply === true || args.apply === 'true';
  const limit = args.limit ? Number(args.limit) : null;
  const batchSize = args.batchSize ? Number(args.batchSize) : 400;

  if (!startStr || !endStr) {
    throw new Error('Usage: node scripts/backfill-totalBreakSeconds.js --start=YYYY-MM-DD --end=YYYY-MM-DD [--teamId=TEAM] [--apply] [--limit=N]');
  }

  const start = new Date(`${startStr}T00:00:00.000Z`);
  const end = new Date(`${endStr}T23:59:59.999Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid --start or --end date');
  }
  if (start > end) {
    throw new Error('--start cannot be after --end');
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  console.log('[backfill-totalBreakSeconds] Starting', {
    start: start.toISOString(),
    end: end.toISOString(),
    teamId: teamId || undefined,
    apply,
    limit: limit || undefined,
    batchSize
  });

  let query = db.collection('worklogs')
    .where('date', '>=', admin.firestore.Timestamp.fromDate(start))
    .where('date', '<=', admin.firestore.Timestamp.fromDate(end));

  if (teamId) {
    query = query.where('teamId', '==', teamId);
  }

  // Deterministic order for paging.
  query = query.orderBy('date', 'asc');

  let updated = 0;
  let scanned = 0;
  let lastDoc = null;

  while (true) {
    let page = query;
    if (lastDoc) page = page.startAfter(lastDoc);
    page = page.limit(Math.min(batchSize, limit ? Math.max(0, limit - scanned) : batchSize));

    const snap = await page.get();
    if (snap.empty) break;

    const batch = db.batch();
    let batchWrites = 0;

    for (const docSnap of snap.docs) {
      const data = docSnap.data();
      scanned += 1;

      const computed = computeBreakSecondsFromBreaks(data);
      if (computed.total == null) {
        // No breaks[] to compute from; skip.
        continue;
      }

      const existing = typeof data.totalBreakSeconds === 'number' ? data.totalBreakSeconds : 0;
      const next = computed.total;

      // Only update when meaningfully different.
      if (Math.abs(existing - next) < 1) {
        continue;
      }

      batchWrites += 1;
      updated += 1;

      if (apply) {
        batch.update(docSnap.ref, {
          totalBreakSeconds: next,
          breakSecondsBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];

    if (batchWrites > 0) {
      console.log('[backfill-totalBreakSeconds] Page', {
        scanned,
        updated,
        batchWrites,
        lastDate: lastDoc.get('date')?.toDate?.()?.toISOString?.() || null
      });

      if (apply) {
        await batch.commit();
      }
    }

    if (limit && scanned >= limit) break;
  }

  console.log('[backfill-totalBreakSeconds] Done', { scanned, updated, apply });
  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write changes.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
