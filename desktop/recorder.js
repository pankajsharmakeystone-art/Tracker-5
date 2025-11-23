let mediaRecorder = null;
let recordedChunks = [];
let stream = null;
export const startDesktopRecording = async (sourceId, sourceName, resolution) => {
    console.log(`Initiating desktop recording for source: ${sourceName} (${sourceId})`);
    if (!window.desktopAPI) {
        console.error("Desktop API is missing.");
        return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        console.warn("Recording is already active.");
        return;
    }
    try {
        // Capture the specific screen using Electron's constraint syntax
        // 'mandatory' is required for chromeMediaSourceId in Electron environment
        const mandatoryConfig = {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
        };
        if (resolution) {
            mandatoryConfig.maxWidth = resolution.width;
            mandatoryConfig.maxHeight = resolution.height;
            mandatoryConfig.minWidth = resolution.width;
            mandatoryConfig.minHeight = resolution.height;
        }
        const constraints = {
            audio: false,
            video: {
                mandatory: mandatoryConfig
            }
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        // Setup MediaRecorder with VP9 preferred
        const mimeType = 'video/webm; codecs=vp9';
        const options = {
            mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm'
        };
        console.log(`Starting MediaRecorder with mimeType: ${options.mimeType}`);
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };
        mediaRecorder.onstop = async () => {
            console.log("Recorder stopped. Processing chunks...");
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const arrayBuffer = await blob.arrayBuffer();
            const fileName = `recording-${Date.now()}.webm`;
            if (window.desktopAPI && window.desktopAPI.notifyRecordingSaved) {
                try {
                    console.log(`Sending ${fileName} (${arrayBuffer.byteLength} bytes) to desktop...`);
                    await window.desktopAPI.notifyRecordingSaved(fileName, arrayBuffer);
                    console.log("Upload handoff successful.");
                }
                catch (ipcError) {
                    console.error("Failed to send recording to desktop app via IPC:", ipcError);
                }
            }
            else {
                console.warn("window.desktopAPI.notifyRecordingSaved is not available.");
            }
            // Cleanup: Stop the stream tracks to release the screen capture icon/resource
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            mediaRecorder = null;
            recordedChunks = [];
        };
        // Start recording, request data every 1000ms (1 second)
        mediaRecorder.start(1000);
        console.log("MediaRecorder started successfully.");
    }
    catch (err) {
        console.error("Error during desktop recording setup:", err);
    }
};
export const stopDesktopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log("Stopping MediaRecorder...");
        mediaRecorder.stop();
    }
    else {
        console.log("No active recording to stop.");
    }
};
