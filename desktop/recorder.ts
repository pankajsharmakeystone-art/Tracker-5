export {};

interface RecordingSession {
  mediaRecorder: MediaRecorder;
  recordedChunks: Blob[];
  stream: MediaStream;
  sourceName: string;
}

const sessions = new Map<string, RecordingSession>();

const buildConstraints = (sourceId: string, resolution?: { width: number; height: number }) => {
  const mandatoryConfig: any = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
  };

  if (resolution) {
    mandatoryConfig.maxWidth = resolution.width;
    mandatoryConfig.maxHeight = resolution.height;
    mandatoryConfig.minWidth = resolution.width;
    mandatoryConfig.minHeight = resolution.height;
  }

  return {
    audio: false,
    video: {
      mandatory: mandatoryConfig,
    },
  } as unknown as MediaStreamConstraints;
};

const sanitizeName = (name: string) => {
  return name.replace(/[^a-z0-9_\-]/gi, '_');
};

const startRecorderForSource = async (sourceId: string, sourceName: string, resolution?: { width: number; height: number }) => {
  if (sessions.has(sourceId)) {
    console.warn(`Recording already active for ${sourceId}`);
    return;
  }

  try {
    const constraints = buildConstraints(sourceId, resolution);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const mimeType = 'video/webm; codecs=vp9';
    const options: MediaRecorderOptions = {
      mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm',
    };

    const recordedChunks: Blob[] = [];
    const mediaRecorder = new MediaRecorder(stream, options);

    sessions.set(sourceId, { mediaRecorder, recordedChunks, stream, sourceName });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log(`Recorder stopped for ${sourceName}`);
      const session = sessions.get(sourceId);
      if (!session) return;

      try {
        const blob = new Blob(session.recordedChunks, { type: 'video/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const safeName = sanitizeName(session.sourceName || 'screen');
        const fileName = `recording-${safeName}-${Date.now()}.webm`;

        if (window.desktopAPI?.notifyRecordingSaved) {
          try {
            console.log(`Sending ${fileName} (${arrayBuffer.byteLength} bytes) to desktop...`);
            await window.desktopAPI.notifyRecordingSaved(fileName, arrayBuffer);
          } catch (ipcError) {
            console.error('Failed to send recording to desktop app via IPC:', ipcError);
          }
        }
      } finally {
        session.stream.getTracks().forEach((track) => track.stop());
        sessions.delete(sourceId);
      }
    };

    mediaRecorder.start(1000);
    console.log(`MediaRecorder started for ${sourceName} (${sourceId})`);
  } catch (err) {
    console.error(`Error starting recording for ${sourceName}:`, err);
  }
};

export const startDesktopRecording = async (sourceId: string | string[], sourceName: string | string[], resolution?: { width: number; height: number }) => {
  if (!window.desktopAPI) {
    console.error('Desktop API is missing.');
    return;
  }

  const ids = Array.isArray(sourceId) ? sourceId : [sourceId];
  const names = Array.isArray(sourceName) ? sourceName : [sourceName];

  const starters = ids.map((id, idx) => startRecorderForSource(id, names[idx] || names[0], resolution));
  await Promise.allSettled(starters);
};

export const stopDesktopRecording = () => {
  if (sessions.size === 0) {
    console.log('No active recordings to stop.');
    return;
  }

  sessions.forEach(({ mediaRecorder }, sourceId) => {
    if (mediaRecorder.state !== 'inactive') {
      console.log(`Stopping recorder for ${sourceId}`);
      mediaRecorder.stop();
    }
  });
};