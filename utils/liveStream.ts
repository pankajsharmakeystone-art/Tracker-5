const STATIC_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: "stun:stun.relay.metered.ca:80",
  },
  {
    urls: "turn:standard.relay.metered.ca:80",
    username: "581dffe8413f03e70f13a158",
    credential: "cpB9F27KdBAai4Ol",
  },
  {
    urls: "turn:standard.relay.metered.ca:80?transport=tcp",
    username: "581dffe8413f03e70f13a158",
    credential: "cpB9F27KdBAai4Ol",
  },
  {
    urls: "turn:standard.relay.metered.ca:443",
    username: "581dffe8413f03e70f13a158",
    credential: "cpB9F27KdBAai4Ol",
  },
  {
    urls: "turns:standard.relay.metered.ca:443?transport=tcp",
    username: "581dffe8413f03e70f13a158",
    credential: "cpB9F27KdBAai4Ol",
  },
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
