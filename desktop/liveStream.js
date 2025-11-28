const buildConstraints = (sourceId, resolution) => {
    const mandatory = {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
    };
    if (resolution) {
        mandatory.maxWidth = resolution.width;
        mandatory.maxHeight = resolution.height;
        mandatory.minWidth = resolution.width;
        mandatory.minHeight = resolution.height;
    }
    return {
        audio: false,
        video: {
            mandatory
        }
    };
};
export const captureDesktopStreamsForLive = async () => {
    if (!window.desktopAPI?.getLiveStreamSources) {
        console.warn('Live stream capture requested but desktop API is unavailable.');
        return [];
    }
    const sourceResult = await window.desktopAPI.getLiveStreamSources();
    if (!sourceResult?.success || !sourceResult.sources?.length) {
        console.warn('No desktop sources returned for live streaming');
        return [];
    }
    const screenSources = sourceResult.sources.filter((src) => src.id?.startsWith('screen'));
    const targets = screenSources.length > 0 ? screenSources : [sourceResult.sources[0]];
    const captures = [];
    for (const source of targets) {
        try {
            const constraints = buildConstraints(source.id, sourceResult.resolution);
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            captures.push({
                stream,
                sourceId: source.id,
                sourceName: source.name,
                resolution: sourceResult.resolution
            });
        }
        catch (err) {
            console.error('Failed to capture source for live stream', source?.name, err);
        }
    }
    return captures;
};
export const stopMediaStreamTracks = (stream) => {
    const streams = Array.isArray(stream) ? stream : stream ? [stream] : [];
    streams.forEach((s) => {
        if (!s)
            return;
        s.getTracks().forEach((track) => {
            try {
                track.stop();
            }
            catch (err) {
                console.warn('Failed to stop media track', err);
            }
        });
    });
};
