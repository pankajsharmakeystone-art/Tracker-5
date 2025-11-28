import { useEffect, useRef } from 'react';
import { useAuth } from './useAuth';
import { captureDesktopStreamForLive, stopMediaStreamTracks } from '../desktop/liveStream';
import { appendCandidate, endLiveSession, getLiveSessionRef, markStreaming, setOffer } from '../services/liveSessions';
import { getRtcConfiguration } from '../utils/liveStream';
import { onSnapshot } from 'firebase/firestore';
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
        console.warn('Agent addIceCandidate failed', err);
    }
};
export const useAgentLiveStream = () => {
    const { userData } = useAuth();
    const pcRef = useRef(null);
        const streamRefs = useRef([]);
    const activeRequestIdRef = useRef(null);
    const processedViewerCandidates = useRef(new Set());
    const endRequestedRef = useRef(false);
    useEffect(() => {
        if (!userData?.uid)
            return;
        if (typeof window === 'undefined' || !window.desktopAPI)
            return;
        const sessionRef = getLiveSessionRef(userData.uid);
        const stopStreaming = async (reason) => {
            if (endRequestedRef.current)
                return;
            endRequestedRef.current = true;
            processedViewerCandidates.current.clear();
            if (pcRef.current) {
                try {
                    pcRef.current.onicecandidate = null;
                    pcRef.current.onconnectionstatechange = null;
                    pcRef.current.close();
                }
                catch (err) {
                    console.warn('Failed to close RTCPeerConnection', err);
                }
                pcRef.current = null;
            }
                stopMediaStreamTracks(streamRefs.current);
                streamRefs.current = [];
            if (reason === 'agent_closed' && activeRequestIdRef.current) {
                try {
                    await endLiveSession(sessionRef, 'agent_closed');
                }
                catch (err) {
                    console.warn('Failed to end live session', err);
                }
            }
            activeRequestIdRef.current = null;
            endRequestedRef.current = false;
        };
        const startBroadcast = async (requestId) => {
            try {
                const capture = await captureDesktopStreamForLive();
                const captures = await captureDesktopStreamsForLive();
                if (!captures.length)
                    return;
                const pc = new RTCPeerConnection(getRtcConfiguration());
                captures.forEach((capture) => {
                    capture.stream.getTracks().forEach((track) => pc.addTrack(track, capture.stream));
                });
                streamRefs.current = captures.map((c) => c.stream);
                pcRef.current = pc;
                processedViewerCandidates.current = new Set();
                activeRequestIdRef.current = requestId;
                endRequestedRef.current = false;
                pc.onicecandidate = async (event) => {
                    if (!event.candidate)
                        return;
                    try {
                        await appendCandidate(sessionRef, 'agent', createCandidatePayload(event.candidate));
                    }
                    catch (err) {
                        console.warn('Failed to append agent ICE candidate', err);
                    }
                };
                pc.onconnectionstatechange = async () => {
                    if (pc.connectionState === 'connected') {
                        try {
                            await markStreaming(sessionRef);
                        }
                        catch (err) {
                            console.warn('Failed to mark streaming', err);
                        }
                    }
                    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
                        await stopStreaming('agent_closed');
                    }
                };
                const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
                await pc.setLocalDescription(offer);
                await setOffer(sessionRef, { type: 'offer', sdp: offer.sdp ?? undefined });
            }
            catch (err) {
                console.error('startBroadcast failed', err);
                await stopStreaming('agent_closed');
            }
        };
        const unsubscribe = onSnapshot(sessionRef, async (snapshot) => {
            const data = snapshot.exists() ? snapshot.data() : null;
            if (!data || !data.viewerUid || !data.requestId) {
                if (activeRequestIdRef.current) {
                    await stopStreaming('viewer_closed');
                }
                return;
            }
            const isSameRequest = data.requestId === activeRequestIdRef.current;
            if (data.status === 'viewer_requested' && !isSameRequest) {
                await startBroadcast(data.requestId);
                return;
            }
            if (!isSameRequest)
                return;
            if (data.status === 'ended') {
                await stopStreaming('viewer_closed');
                return;
            }
            if (data.answer && pcRef.current && !pcRef.current.currentRemoteDescription) {
                try {
                    await pcRef.current.setRemoteDescription({ type: 'answer', sdp: data.answer.sdp });
                }
                catch (err) {
                    console.error('Failed to set remote description on agent', err);
                }
            }
            if (pcRef.current && data.viewerIceCandidates?.length) {
                for (const candidate of data.viewerIceCandidates) {
                    if (!candidate?.id || processedViewerCandidates.current.has(candidate.id))
                        continue;
                    processedViewerCandidates.current.add(candidate.id);
                    await addIceCandidateSafely(pcRef.current, candidate);
                }
            }
        });
        return () => {
            unsubscribe();
            stopStreaming('agent_closed');
        };
    }, [userData?.uid]);
};
