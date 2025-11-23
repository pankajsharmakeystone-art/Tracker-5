import { arrayUnion, deleteField, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
export const getLiveSessionRef = (agentUid) => {
    return doc(db, 'liveSessions', agentUid);
};
export const createViewerRequest = async (params) => {
    const { agentUid, agentDisplayName, viewerUid, viewerDisplayName, teamId } = params;
    const requestId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionRef = getLiveSessionRef(agentUid);
    await setDoc(sessionRef, {
        agentUid,
        agentDisplayName: agentDisplayName ?? undefined,
        viewerUid,
        viewerDisplayName: viewerDisplayName ?? undefined,
        status: 'viewer_requested',
        requestId,
        offer: null,
        answer: null,
        agentIceCandidates: [],
        viewerIceCandidates: [],
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        teamId: teamId ?? undefined,
        resolution: null,
        endReason: null
    });
    return { requestId, sessionRef };
};
export const appendCandidate = async (sessionRef, role, candidate) => {
    const field = role === 'agent' ? 'agentIceCandidates' : 'viewerIceCandidates';
    await updateDoc(sessionRef, {
        [field]: arrayUnion({ ...candidate, createdAt: Date.now() }),
        updatedAt: serverTimestamp()
    });
};
export const setOffer = async (sessionRef, offer) => {
    await updateDoc(sessionRef, {
        offer,
        status: 'offer_created',
        answer: null,
        viewerIceCandidates: [],
        agentIceCandidates: [],
        updatedAt: serverTimestamp()
    });
};
export const setAnswer = async (sessionRef, answer) => {
    await updateDoc(sessionRef, {
        answer,
        status: 'answer_created',
        updatedAt: serverTimestamp()
    });
};
export const markStreaming = async (sessionRef) => {
    await updateDoc(sessionRef, {
        status: 'streaming',
        updatedAt: serverTimestamp()
    });
};
export const endLiveSession = async (sessionRef, reason) => {
    await updateDoc(sessionRef, {
        status: 'ended',
        viewerUid: null,
        viewerDisplayName: null,
        requestId: null,
        offer: deleteField(),
        answer: deleteField(),
        agentIceCandidates: deleteField(),
        viewerIceCandidates: deleteField(),
        updatedAt: serverTimestamp(),
        endReason: reason,
        resolution: null
    });
};
export const subscribeToLiveSession = (agentUid, cb) => {
    const ref = getLiveSessionRef(agentUid);
    return onSnapshot(ref, (snap) => {
        cb(snap.exists() ? snap.data() : null);
    });
};
