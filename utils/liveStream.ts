const STATIC_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:bn-turn1.xirsys.com'] },
  {
    urls: [
      'turn:bn-turn1.xirsys.com:80?transport=udp',
      'turn:bn-turn1.xirsys.com:3478?transport=udp',
      'turn:bn-turn1.xirsys.com:80?transport=tcp',
      'turn:bn-turn1.xirsys.com:3478?transport=tcp',
      'turns:bn-turn1.xirsys.com:443?transport=tcp',
      'turns:bn-turn1.xirsys.com:5349?transport=tcp'
    ],
    username: 'mzLEzMAK6_smpH3QyPlZwH2Kpx5hrB1p7qUXhUqWPgebqH-Pule5eny0uTI6L17fAAAAAGk6n0twYW5rYWoyNzgxOTkx',
    credential: '9eeb819e-d67d-11f0-bb95-0242ac140004'
  },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
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
