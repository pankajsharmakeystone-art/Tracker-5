const admin = require('firebase-admin');

// TODO: Replace with the path to your service account key
const serviceAccount = require('./serviceAccountKey.json');

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