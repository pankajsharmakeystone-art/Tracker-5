export const getRtcConfiguration = () => {
    const baseServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];
    const turnUrl = import.meta.env.VITE_TURN_SERVER_URL;
    const turnUsername = import.meta.env.VITE_TURN_USERNAME;
    const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL;
    if (turnUrl && turnUsername && turnCredential) {
        const urls = turnUrl.split(',').map((entry) => entry.trim()).filter(Boolean);
        if (urls.length > 0) {
            baseServers.push({ urls, username: turnUsername, credential: turnCredential });
        }
    }
    return {
        iceServers: baseServers,
        iceTransportPolicy: turnUrl ? 'relay' : 'all'
    };
};
