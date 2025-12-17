import { getFirebaseServices } from './_lib/firebaseAdmin.js';

const withCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

export default async function handler(req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const teamIdRaw = req.query?.teamId;
    const teamId = Array.isArray(teamIdRaw) ? teamIdRaw[0] : teamIdRaw;

    if (!teamId || typeof teamId !== 'string') {
      return res.status(400).json({ valid: false, error: 'missing_teamId' });
    }

    const { firestore } = getFirebaseServices();
    const snap = await firestore.collection('teams').doc(teamId).get();

    if (!snap.exists) {
      return res.status(404).json({ valid: false, error: 'invalid_or_expired' });
    }

    const data = snap.data() || {};
    return res.status(200).json({
      valid: true,
      team: {
        id: snap.id,
        name: data.name || ''
      }
    });
  } catch (error) {
    console.error('[validate-invite] failed', error);
    return res.status(500).json({ valid: false, error: 'server_error' });
  }
}
