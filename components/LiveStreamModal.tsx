import React, { useEffect } from 'react';
import { useLiveScreenViewer } from '../hooks/useLiveScreenViewer';
import type { ViewerState } from '../hooks/useLiveScreenViewer';

interface LiveStreamModalProps {
  isOpen: boolean;
  agent: {
    uid: string;
    displayName: string;
    teamId?: string;
  } | null;
  onClose: () => void;
}

const STATE_COPY: Record<ViewerState, { title: string; description: string }> = {
  idle: { title: 'Standby', description: 'Request a stream to begin live viewing.' },
  requesting: { title: 'Request Sent', description: 'Waiting for the agent desktop to acknowledge the request.' },
  waiting: { title: 'Waiting for Agent', description: 'Agent desktop is preparing the live stream.' },
  connecting: { title: 'Connecting', description: 'Negotiating secure peer connection…' },
  streaming: { title: 'Live', description: 'You are viewing the agent desktop in real time.' },
  ended: { title: 'Session Ended', description: 'The live stream has ended.' },
  error: { title: 'Error', description: 'Unable to establish the live session.' }
};

const LiveStreamModal: React.FC<LiveStreamModalProps> = ({ isOpen, agent, onClose }) => {
  const { videoRef, state, error, endSession } = useLiveScreenViewer(agent, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    return () => {
      endSession();
    };
  }, [isOpen, endSession]);

  if (!isOpen || !agent) return null;

  const handleClose = async () => {
    await endSession();
    onClose();
  };

  const copy = STATE_COPY[state];

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-5xl bg-gray-900 text-white rounded-3xl overflow-hidden shadow-2xl border border-white/10">
        <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-gray-400">Live Screen Request</p>
            <h2 className="text-2xl font-semibold">{agent.displayName}</h2>
            <p className="text-sm text-gray-400">{copy?.title}</p>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white transition-colors text-3xl leading-none"
            aria-label="Close live stream modal"
          >
            &times;
          </button>
        </header>

        <div className="bg-black relative aspect-video">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-contain transition-opacity duration-300 ${state === 'streaming' ? 'opacity-100' : 'opacity-0'}`}
          />

          {state !== 'streaming' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
              <div className="w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin mb-6" aria-hidden />
              <h3 className="text-xl font-semibold mb-2">{copy?.title ?? 'Preparing Stream'}</h3>
              <p className="text-gray-300 max-w-lg">{error ?? copy?.description ?? 'Setting up secure connection…'}</p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between px-6 py-4 border-t border-white/10 bg-gray-950">
          <div className="text-sm text-gray-400">
            {error ? <span className="text-red-400">{error}</span> : copy?.description}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-white/10 hover:bg-white/20 text-white"
            >
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default LiveStreamModal;
