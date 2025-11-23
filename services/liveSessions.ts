import { arrayUnion, deleteField, doc, onSnapshot, serverTimestamp, setDoc, updateDoc, type DocumentReference } from 'firebase/firestore';
import { db } from './firebase';

export interface LiveSessionCandidate {
  id: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  createdAt?: any;
}

export interface SessionDescriptionPayload {
  type: 'offer' | 'answer';
  sdp?: string;
}

export interface LiveSessionDoc {
  agentUid: string;
  agentDisplayName?: string;
  viewerUid: string | null;
  viewerDisplayName?: string | null;
  status: 'viewer_requested' | 'offer_created' | 'answer_created' | 'streaming' | 'ended';
  requestId: string | null;
  offer?: SessionDescriptionPayload | null;
  answer?: SessionDescriptionPayload | null;
  agentIceCandidates?: LiveSessionCandidate[];
  viewerIceCandidates?: LiveSessionCandidate[];
  updatedAt?: any;
  createdAt?: any;
  teamId?: string;
  resolution?: { width: number; height: number } | null;
  endReason?: 'viewer_closed' | 'agent_closed' | 'expired' | 'error' | null;
}

export const getLiveSessionRef = (agentUid: string): DocumentReference<LiveSessionDoc> => {
  return doc(db, 'liveSessions', agentUid) as DocumentReference<LiveSessionDoc>;
};

export const createViewerRequest = async (params: {
  agentUid: string;
  agentDisplayName?: string;
  viewerUid: string;
  viewerDisplayName?: string | null;
  teamId?: string;
}) => {
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

export const appendCandidate = async (
  sessionRef: DocumentReference<LiveSessionDoc>,
  role: 'agent' | 'viewer',
  candidate: LiveSessionCandidate
) => {
  const field = role === 'agent' ? 'agentIceCandidates' : 'viewerIceCandidates';
  await updateDoc(sessionRef, {
    [field]: arrayUnion({ ...candidate, createdAt: serverTimestamp() }),
    updatedAt: serverTimestamp()
  } as any);
};

export const setOffer = async (
  sessionRef: DocumentReference<LiveSessionDoc>,
  offer: SessionDescriptionPayload
) => {
  await updateDoc(sessionRef, {
    offer,
    status: 'offer_created',
    answer: null,
    viewerIceCandidates: [],
    agentIceCandidates: [],
    updatedAt: serverTimestamp()
  });
};

export const setAnswer = async (
  sessionRef: DocumentReference<LiveSessionDoc>,
  answer: SessionDescriptionPayload
) => {
  await updateDoc(sessionRef, {
    answer,
    status: 'answer_created',
    updatedAt: serverTimestamp()
  });
};

export const markStreaming = async (
  sessionRef: DocumentReference<LiveSessionDoc>
) => {
  await updateDoc(sessionRef, {
    status: 'streaming',
    updatedAt: serverTimestamp()
  });
};

export const endLiveSession = async (
  sessionRef: DocumentReference<LiveSessionDoc>,
  reason: 'viewer_closed' | 'agent_closed' | 'expired' | 'error'
) => {
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
  } as any);
};

export const subscribeToLiveSession = (
  agentUid: string,
  cb: (data: LiveSessionDoc | null) => void
) => {
  const ref = getLiveSessionRef(agentUid);
  return onSnapshot(ref, (snap) => {
    cb(snap.exists() ? (snap.data() as LiveSessionDoc) : null);
  });
};
