import React, { useEffect, useRef, useState } from 'react';
import { useLiveScreenViewer, type RemoteFeed } from '../hooks/useLiveScreenViewer';
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

const LiveFeedTile: React.FC<{ feed: RemoteFeed; index: number }> = ({ feed, index }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = feed.stream;
    }
  }, [feed.stream]);

  return (
    <div className="relative aspect-video rounded-2xl border border-white/10 bg-black overflow-hidden">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain"
      />
      <div className="absolute bottom-2 left-2 text-xs uppercase tracking-wide bg-black/60 px-2 py-1 rounded text-white">
        {feed.label || `Screen ${index + 1}`}
      </div>
    </div>
  );
};

const LiveStreamModal: React.FC<LiveStreamModalProps> = ({ isOpen, agent, onClose }) => {
  const { remoteFeeds, state, error, endSession } = useLiveScreenViewer(agent, isOpen);
  const [expanded, setExpanded] = useState(false);

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
    setExpanded(false);
  };

  const copy = STATE_COPY[state];
  const containerClass = expanded
    ? 'w-full h-full max-w-[1600px]'
    : 'w-full max-w-5xl max-h-[90vh]';
  const bodyHeightClass = expanded ? 'min-h-[70vh]' : 'min-h-[320px]';

  return (
    <div
      className={`fixed inset-0 z-[120] flex ${expanded ? 'items-stretch' : 'items-center'} justify-center bg-black/70 backdrop-blur-sm p-4`}
      role="dialog"
      aria-modal="true"
    >
      <div className={`${containerClass} bg-gray-900 text-white rounded-3xl overflow-hidden shadow-2xl border border-white/10 flex flex-col`}>
        <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-gray-400">Live Screen Request</p>
            <h2 className="text-2xl font-semibold">{agent.displayName}</h2>
            <p className="text-sm text-gray-400">{copy?.title}</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setExpanded((prev) => !prev)}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-white/10 hover:bg-white/20 text-white"
            >
              {expanded ? 'Exit Full Size' : 'Full Size'}
            </button>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white transition-colors text-3xl leading-none"
              aria-label="Close live stream modal"
            >
              &times;
            </button>
          </div>
        </header>

        <div className={`bg-black relative flex-1 ${bodyHeightClass}`}>
          {remoteFeeds.length > 0 && (
            <div className={`grid gap-4 p-4 ${remoteFeeds.length > 1 ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
              {remoteFeeds.map((feed, idx) => (
                <LiveFeedTile key={feed.id} feed={feed} index={idx} />
              ))}
            </div>
          )}

          {(state !== 'streaming' || remoteFeeds.length === 0) && (
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
