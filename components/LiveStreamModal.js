import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { useLiveScreenViewer } from '../hooks/useLiveScreenViewer';
const STATE_COPY = {
    idle: { title: 'Standby', description: 'Request a stream to begin live viewing.' },
    requesting: { title: 'Request Sent', description: 'Waiting for the agent desktop to acknowledge the request.' },
    waiting: { title: 'Waiting for Agent', description: 'Agent desktop is preparing the live stream.' },
    connecting: { title: 'Connecting', description: 'Negotiating secure peer connection…' },
    streaming: { title: 'Live', description: 'You are viewing the agent desktop in real time.' },
    ended: { title: 'Session Ended', description: 'The live stream has ended.' },
    error: { title: 'Error', description: 'Unable to establish the live session.' }
};
const LiveFeedTile = ({ feed, index }) => {
    const videoRef = useRef(null);
    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.srcObject = feed.stream;
        }
    }, [feed.stream]);
    return (_jsxs("div", { className: "relative aspect-video rounded-2xl border border-white/10 bg-black overflow-hidden", children: [_jsx("video", { ref: videoRef, autoPlay: true, playsInline: true, muted: true, className: "w-full h-full object-contain" }), _jsx("div", { className: "absolute bottom-2 left-2 text-xs uppercase tracking-wide bg-black/60 px-2 py-1 rounded text-white", children: feed.label || `Screen ${index + 1}` })] }));
};
const LiveStreamModal = ({ isOpen, agent, onClose }) => {
    const { remoteFeeds, state, error, endSession } = useLiveScreenViewer(agent, isOpen);
    useEffect(() => {
        if (!isOpen)
            return;
        return () => {
            endSession();
        };
    }, [isOpen, endSession]);
    if (!isOpen || !agent)
        return null;
    const handleClose = async () => {
        await endSession();
        onClose();
    };
    const copy = STATE_COPY[state];
    return (_jsx("div", { className: "fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4", role: "dialog", "aria-modal": "true", children: _jsxs("div", { className: "w-full max-w-5xl bg-gray-900 text-white rounded-3xl overflow-hidden shadow-2xl border border-white/10", children: [_jsxs("header", { className: "flex items-center justify-between px-6 py-4 border-b border-white/10", children: [_jsxs("div", { children: [_jsx("p", { className: "text-xs uppercase tracking-[0.3em] text-gray-400", children: "Live Screen Request" }), _jsx("h2", { className: "text-2xl font-semibold", children: agent.displayName }), _jsx("p", { className: "text-sm text-gray-400", children: copy?.title })] }), _jsx("button", { onClick: handleClose, className: "text-gray-400 hover:text-white transition-colors text-3xl leading-none", "aria-label": "Close live stream modal", children: "\u00D7" })] }), _jsxs("div", { className: "bg-black relative min-h-[320px]", children: [remoteFeeds.length > 0 && (_jsx("div", { className: `grid gap-4 p-4 ${remoteFeeds.length > 1 ? 'md:grid-cols-2' : 'grid-cols-1'}`, children: remoteFeeds.map((feed, idx) => (_jsx(LiveFeedTile, { feed: feed, index: idx }, feed.id))) })), ((state !== 'streaming') || remoteFeeds.length === 0) && (_jsxs("div", { className: "absolute inset-0 flex flex-col items-center justify-center text-center px-8", children: [_jsx("div", { className: "w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin mb-6", "aria-hidden": true }), _jsx("h3", { className: "text-xl font-semibold mb-2", children: copy?.title ?? 'Preparing Stream' }), _jsx("p", { className: "text-gray-300 max-w-lg", children: error ?? copy?.description ?? 'Setting up secure connection…' })] }))] }), _jsxs("footer", { className: "flex items-center justify-between px-6 py-4 border-t border-white/10 bg-gray-950", children: [_jsx("div", { className: "text-sm text-gray-400", children: error ? _jsx("span", { className: "text-red-400", children: error }) : copy?.description }), _jsx("div", { className: "flex gap-3", children: _jsx("button", { onClick: handleClose, className: "px-4 py-2 text-sm font-medium rounded-lg bg-white/10 hover:bg-white/20 text-white", children: "Close" }) })] })] }) }));
};
export default LiveStreamModal;
