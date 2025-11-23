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
export const captureDesktopStreamForLive = async () => {
    if (!window.desktopAPI?.getLiveStreamSources) {
        console.warn('Live stream capture requested but desktop API is unavailable.');
        return null;
    }
    const sourceResult = await window.desktopAPI.getLiveStreamSources();
    if (!sourceResult?.success || !sourceResult.sources?.length) {
        console.warn('No desktop sources returned for live streaming');
        return null;
    }
    const selectedSource = sourceResult.sources[0];
    const constraints = buildConstraints(selectedSource.id, sourceResult.resolution);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    return {
        stream,
        sourceId: selectedSource.id,
        sourceName: selectedSource.name,
        resolution: sourceResult.resolution
    };
};
export const stopMediaStreamTracks = (stream) => {
    if (!stream)
        return;
    stream.getTracks().forEach((track) => {
        try {
            track.stop();
        }
        catch (err) {
            console.warn('Failed to stop media track', err);
        }
    });
};
