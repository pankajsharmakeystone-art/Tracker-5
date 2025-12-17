const STATIC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:80.225.201.28:3478?transport=tcp',
    username: 'turnuser',
    credential: 'StrongTurnPassword123'
  }
];

export const getRtcConfiguration = (): RTCConfiguration => {
  const iceServers: RTCIceServer[] = [...STATIC_ICE_SERVERS];

  // Optional env override/extension for TURN
  const turnUrl = import.meta.env.VITE_TURN_SERVER_URL;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;

  if (turnUrl && turnUsername && turnCredential) {
    const urls = turnUrl.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (urls.length > 0) {
      iceServers.push({ urls, username: turnUsername, credential: turnCredential });
    }
  }

  const hasTurn = iceServers.some((s) => Array.isArray(s.urls) ? s.urls.some((u) => u.startsWith('turn')) : String(s.urls || '').startsWith('turn'));

  return {
    iceServers,
    iceTransportPolicy: hasTurn ? 'relay' : 'all'
  };
};
