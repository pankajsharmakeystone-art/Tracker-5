import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_ADMIN_SDK_JSON;
  if (inlineJson) {
    return JSON.parse(inlineJson);
  }

  const explicitPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    || process.env.FIREBASE_ADMIN_SDK_PATH
    || process.env.FIREBASE_KEY_PATH
    || path.join(process.cwd(), 'firebase-service-account.json');

  if (!fs.existsSync(explicitPath)) {
    throw new Error(
      `Set FIREBASE_SERVICE_ACCOUNT_PATH (or provide FIREBASE_SERVICE_ACCOUNT_JSON) before running migrateWorklogTypes.js. Checked: ${explicitPath}`
    );
  }

  return JSON.parse(fs.readFileSync(explicitPath, 'utf8'));
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrateWorklogs() {
  const worklogsRef = db.collection('worklogs');
  const snapshot = await worklogsRef.get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    let updated = false;

    // Get all numeric keys (segments)
    const keys = Object.keys(data).filter(key => !isNaN(Number(key)));
    keys.sort((a, b) => {
      const aStart = data[a].startTime?.seconds || 0;
      const bStart = data[b].startTime?.seconds || 0;
      return aStart - bStart;
    });

    keys.forEach((key, idx) => {
      if (!data[key].type) {
        data[key].type = idx % 2 === 0 ? 'Working' : 'On Break';
        updated = true;
      }
    });

    if (updated) {
      await doc.ref.update(data);
      console.log(`Updated worklog: ${doc.id}`);
    }
  }

  console.log('Migration complete.');
}

migrateWorklogs().catch(console.error);