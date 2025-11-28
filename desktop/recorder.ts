export {};

interface RecordingSession {
  mediaRecorder: MediaRecorder;
  recordedChunks: Blob[];
  stream: MediaStream;
  sourceName: string;
  finalizePromise: Promise<void>;
}

const sessions = new Map<string, RecordingSession>();

const waitForPreviousSession = async (sourceId: string) => {
  const existing = sessions.get(sourceId);
  if (!existing) return;

  console.warn(`Recording already active for ${sourceId}, waiting for cleanup`);
  try {
    await existing.finalizePromise;
  } catch (err) {
    console.error(`Error while waiting for recorder cleanup (${sourceId}):`, err);
  }
};

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

const startRecorderForSource = async (
  sourceId: string,
  sourceName: string,
  resolution?: { width: number; height: number }
): Promise<boolean> => {
  if (sessions.has(sourceId)) {
    await waitForPreviousSession(sourceId);
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

    let finalizeResolve: (() => void) | null = null;
    const finalizePromise = new Promise<void>((resolve) => {
      finalizeResolve = resolve;
    });

    sessions.set(sourceId, { mediaRecorder, recordedChunks, stream, sourceName, finalizePromise });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onerror = (event) => {
      console.error(`Recorder error for ${sourceName}:`, event?.error || event);
    };

    mediaRecorder.onstop = async () => {
      console.log(`Recorder stopped for ${sourceName}`);
      const session = sessions.get(sourceId);
      if (!session) {
        finalizeResolve?.();
        return;
      }

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
        finalizeResolve?.();
      }
    };

    mediaRecorder.start(1000);
    console.log(`MediaRecorder started for ${sourceName} (${sourceId})`);
    return true;
  } catch (err) {
    console.error(`Error starting recording for ${sourceName}:`, err);
    return false;
  }
};

export const startDesktopRecording = async (sourceId: string | string[], sourceName: string | string[], resolution?: { width: number; height: number }) => {
  if (!window.desktopAPI) {
    console.error('Desktop API is missing.');
    return;
  }

  const ids = Array.isArray(sourceId) ? sourceId : [sourceId];
  const names = Array.isArray(sourceName) ? sourceName : [sourceName];

  const results: { id: string; success: boolean }[] = [];

  for (let idx = 0; idx < ids.length; idx += 1) {
    const id = ids[idx];
    const name = names[idx] || names[0] || 'screen';
    const success = await startRecorderForSource(id, name, resolution);
    results.push({ id, success });
  }

  const successCount = results.filter((r) => r.success).length;

  if (successCount === 0) {
    console.error('Failed to start recording for all requested desktop sources. Informing desktop to reset.');
    try {
      if (window.desktopAPI?.stopRecording) {
        await window.desktopAPI.stopRecording();
      }
    } catch (stopErr) {
      console.error('Failed to notify desktop about recording failure:', stopErr);
    }
  } else if (successCount < results.length) {
    console.warn('Only a subset of desktop sources started recording:', results);
  }
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