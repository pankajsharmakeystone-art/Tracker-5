const { ipcRenderer, desktopCapturer } = require('electron');

// Minimal recorder that lives in a hidden window. It records all screen sources and sends
// finished blobs back to the main process for saving/uploading.

const sessions = new Map();

const sanitizeName = (name) => (name || 'screen').replace(/[^a-z0-9_\-]/gi, '_');

const buildConstraints = (sourceId, resolution) => {
  const mandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId
  };
  if (resolution && resolution.width && resolution.height) {
    mandatory.maxWidth = resolution.width;
    mandatory.maxHeight = resolution.height;
    mandatory.minWidth = resolution.width;
    mandatory.minHeight = resolution.height;
  }
  return {
    audio: false,
    video: { mandatory }
  };
};

async function startRecorderForSource(source, resolution) {
  const { id, name } = source;
  const constraints = buildConstraints(id, resolution);
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const mimeType = 'video/webm; codecs=vp9';
  const options = {
    mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm'
  };

  const recordedChunks = [];
  const mediaRecorder = new MediaRecorder(stream, options);
  let finalizeResolve;
  const finalizePromise = new Promise((resolve) => { finalizeResolve = resolve; });

  sessions.set(id, { mediaRecorder, recordedChunks, stream, sourceName: name, finalizePromise });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };

  mediaRecorder.onerror = (event) => {
    console.error('[recorder] error', event?.error || event);
  };

  mediaRecorder.onstop = async () => {
    const session = sessions.get(id);
    try {
      if (!session) return;
      const blob = new Blob(session.recordedChunks, { type: 'video/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      const safeName = sanitizeName(session.sourceName || 'screen');
      const fileName = `recording-${safeName}-${Date.now()}.webm`;
      const isLastSession = sessions.size === 1;
      await ipcRenderer.invoke('recorder-save', fileName, arrayBuffer, { isLastSession });
    } catch (err) {
      console.error('[recorder] failed to send recording', err);
    } finally {
      try {
        session?.stream?.getTracks()?.forEach((t) => t.stop());
      } catch (e) {}
      sessions.delete(id);
      finalizeResolve?.();
    }
  };

  mediaRecorder.start(1000);
  console.log('[recorder] started', name, id);
}

async function stopAllRecorders() {
  if (sessions.size === 0) return;
  sessions.forEach(({ mediaRecorder }) => {
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch (err) {
      console.warn('[recorder] stop failed', err);
    }
  });
}

async function stopAndFlushAllRecorders() {
  if (sessions.size === 0) return;
  const finalizePromises = Array.from(sessions.values()).map((s) => s.finalizePromise);
  await stopAllRecorders();
  try {
    await Promise.allSettled(finalizePromises);
  } catch (err) {
    console.warn('[recorder] flush wait failed', err);
  }
}

ipcRenderer.on('recorder-start', async (_event, payload = {}) => {
  try {
    const quality = String(payload.recordingQuality || '720p');
    const mapping = {
      '480p': { width: 640, height: 480 },
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 }
    };
    const resolution = mapping[quality] || mapping['720p'];

    const sourcesResult = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const screenSources = sourcesResult.filter((src) => src.id?.startsWith('screen') || /screen/i.test(src.name));
    const targets = screenSources.length > 0 ? screenSources : sourcesResult;

    for (const src of targets) {
      await startRecorderForSource(src, resolution);
    }
  } catch (error) {
    console.error('[recorder] failed to start', error);
    await stopAllRecorders();
    ipcRenderer.invoke('recorder-failed', { error: error?.message || String(error) }).catch(() => {});
  }
});

ipcRenderer.on('recorder-stop', async () => {
  try {
    await stopAllRecorders();
  } catch (err) {
    console.warn('[recorder] stopAll failed', err);
  }
});

ipcRenderer.on('recorder-stop-and-flush', async () => {
  try {
    await stopAndFlushAllRecorders();
  } catch (err) {
    console.warn('[recorder] stop-and-flush failed', err);
  } finally {
    try {
      ipcRenderer.send('recorder-flushed');
    } catch (e) {
      console.warn('[recorder] failed to notify flushed', e);
    }
  }
});
