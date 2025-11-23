import { useCallback, useEffect, useRef, useState } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { useAuth } from './useAuth';
import { appendCandidate, createViewerRequest, endLiveSession, getLiveSessionRef, setAnswer } from '../services/liveSessions';
import { getRtcConfiguration } from '../utils/liveStream';
const createCandidatePayload = (candidate) => ({
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : null
});
const addIceCandidateSafely = async (pc, candidate) => {
    if (!candidate?.candidate)
        return;
    const rtcCandidate = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : undefined
    };
    try {
        await pc.addIceCandidate(rtcCandidate);
    }
    catch (err) {
        console.warn('Viewer addIceCandidate failed', err);
    }
};
export const useLiveScreenViewer = (agent, isOpen) => {
    const { userData } = useAuth();
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);
    const videoRef = useRef(null);
    const pcRef = useRef(null);
    const unsubscribeRef = useRef(null);
    const activeRequestIdRef = useRef(null);
    const processedAgentCandidates = useRef(new Set());
    const cleanup = useCallback(async (reason) => {
        if (unsubscribeRef.current) {
            unsubscribeRef.current();
            unsubscribeRef.current = null;
        }
        if (pcRef.current) {
            try {
                pcRef.current.onicecandidate = null;
                pcRef.current.ontrack = null;
                pcRef.current.onconnectionstatechange = null;
                pcRef.current.close();
            }
            catch (err) {
                console.warn('Failed to close viewer RTCPeerConnection', err);
            }
            pcRef.current = null;
        }
        processedAgentCandidates.current.clear();
        const videoEl = videoRef.current;
        if (videoEl) {
            const currentStream = videoEl.srcObject;
            if (currentStream) {
                currentStream.getTracks().forEach((track) => {
                    try {
                        track.stop();
                    }
                    catch (err) {
                        console.warn('Failed to stop remote track', err);
                    }
                });
            }
            videoEl.srcObject = null;
        }
        if (reason === 'viewer_closed' && activeRequestIdRef.current && agent) {
            try {
                await endLiveSession(getLiveSessionRef(agent.uid), 'viewer_closed');
            }
            catch (err) {
                console.warn('Failed to mark live session ended by viewer', err);
            }
        }
        activeRequestIdRef.current = null;
        if (reason === 'agent_closed') {
            setState('ended');
        }
        else if (reason === 'error') {
            setState('error');
        }
    }, [agent]);
    useEffect(() => {
        if (!isOpen || !agent) {
            return () => undefined;
        }
        if (!userData?.uid) {
            setError('You must be signed in to start live viewing.');
            setState('error');
            return () => undefined;
        }
        const viewerName = userData.displayName || userData.email || 'Viewer';
        const sessionRef = getLiveSessionRef(agent.uid);
        setState('requesting');
        setError(null);
        createViewerRequest({
            agentUid: agent.uid,
            agentDisplayName: agent.displayName,
            viewerUid: userData.uid,
            viewerDisplayName: viewerName,
            teamId: agent.teamId
        })
            .then(({ requestId }) => {
            activeRequestIdRef.current = requestId;
            processedAgentCandidates.current = new Set();
            setState('waiting');
            const unsubscribe = onSnapshot(sessionRef, async (snapshot) => {
                const data = snapshot.exists() ? snapshot.data() : null;
                if (!data || !data.requestId || data.requestId !== activeRequestIdRef.current) {
                    return;
                }
                if (data.status === 'ended') {
                    await cleanup('agent_closed');
                    return;
                }
                if (data.offer && !pcRef.current) {
                    try {
                        const pc = new RTCPeerConnection(getRtcConfiguration());
                        pcRef.current = pc;
                        pc.ontrack = (event) => {
                            if (videoRef.current && event.streams[0]) {
                                videoRef.current.srcObject = event.streams[0];
                                setState('streaming');
                            }
                        };
                        pc.onicecandidate = async (evt) => {
                            if (!evt.candidate)
                                return;
                            try {
                                await appendCandidate(sessionRef, 'viewer', createCandidatePayload(evt.candidate));
                            }
                            catch (err) {
                                console.warn('Failed to append viewer ICE candidate', err);
                            }
                        };
                        pc.onconnectionstatechange = () => {
                            if (pc.connectionState === 'connected') {
                                setState('streaming');
                            }
                            if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
                                cleanup('agent_closed');
                            }
                        };
                        await pc.setRemoteDescription({ type: 'offer', sdp: data.offer.sdp });
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        await setAnswer(sessionRef, { type: 'answer', sdp: answer.sdp ?? undefined });
                        setState('connecting');
                    }
                    catch (err) {
                        console.error('Failed to establish live viewer peer connection', err);
                        setError('Unable to negotiate the live stream.');
                        setState('error');
                        await cleanup('error');
                        return;
                    }
                }
                if (pcRef.current && data.agentIceCandidates?.length) {
                    for (const candidate of data.agentIceCandidates) {
                        if (!candidate?.id || processedAgentCandidates.current.has(candidate.id))
                            continue;
                        processedAgentCandidates.current.add(candidate.id);
                        await addIceCandidateSafely(pcRef.current, candidate);
                    }
                }
            });
            unsubscribeRef.current = unsubscribe;
        })
            .catch((err) => {
            console.error('createViewerRequest failed', err);
            setError('Failed to request live stream.');
            setState('error');
        });
        return () => {
            cleanup('viewer_closed');
        };
    }, [agent, isOpen, userData?.uid, cleanup]);
    const endSession = useCallback(async () => {
        await cleanup('viewer_closed');
        setState('ended');
    }, [cleanup]);
    return { videoRef, state, error, endSession };
};
