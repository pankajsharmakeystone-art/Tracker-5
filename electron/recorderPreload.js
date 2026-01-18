const { ipcRenderer, desktopCapturer } = require('electron');

// Minimal recorder that lives in a hidden window. It records all screen sources and sends
// finished blobs back to the main process for saving/uploading.

const sessions = new Map();
let nextSaveMeta = null;

const sanitizeName = (name) => (name || 'screen').replace(/[^a-z0-9_\-]/gi, '_');

const buildConstraints = (sourceId, resolution, fps) => {
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
  if (fps && Number.isFinite(fps)) {
    mandatory.maxFrameRate = fps;
    mandatory.minFrameRate = fps;
  }
  return {
    audio: false,
    video: { mandatory }
  };
};

async function startRecorderForSource(source, resolution, fps) {
  const { id, name } = source;
  const constraints = buildConstraints(id, resolution, fps);
  const mediaDevices = navigator.mediaDevices;
  const legacyGetUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)?.bind(navigator);
  const getUserMediaFn = (mediaDevices && mediaDevices.getUserMedia) ? mediaDevices.getUserMedia.bind(mediaDevices) : legacyGetUserMedia;

  if (!getUserMediaFn) {
    console.error('[recorder] mediaDevices missing in recorder window');
    throw new Error('getUserMedia unavailable in recorder window');
  }

  const stream = await getUserMediaFn(constraints);
  const mimeType = 'video/webm; codecs=vp9';
  const options = {
    mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm'
  };

  const recordedChunks = [];
  const mediaRecorder = new MediaRecorder(stream, options);
  let finalizeResolve;
  const finalizePromise = new Promise((resolve) => { finalizeResolve = resolve; });
  const startTime = Date.now();

  sessions.set(id, { mediaRecorder, recordedChunks, stream, sourceName: name, finalizePromise, startTime });

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
      const durationMs = session.startTime ? (Date.now() - session.startTime) : null;
      const saveMeta = { isLastSession, durationMs, ...(nextSaveMeta || {}) };
      ipcRenderer.invoke('recorder-save', fileName, arrayBuffer, saveMeta)
        .catch((err) => console.error('[recorder] failed to send recording', err));
    } catch (err) {
      console.error('[recorder] failed to prepare recording', err);
    } finally {
      try {
        session?.stream?.getTracks()?.forEach((t) => t.stop());
      } catch (e) { }
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
    const fps = Number(payload.recordingFps || 30);
    const mapping = {
      '480p': { width: 640, height: 480 },
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 }
    };
    const resolution = mapping[quality] || mapping['720p'];

    const res = await ipcRenderer.invoke('recorder-get-sources');
    if (!res?.success) {
      throw new Error(res?.error || 'no-sources');
    }

    const sourcesResult = res.sources || [];
    const screenSources = sourcesResult.filter((src) => src.id?.startsWith('screen') || /screen/i.test(src.name));
    const targets = screenSources.length > 0 ? screenSources : sourcesResult;

    for (const src of targets) {
      await startRecorderForSource(src, resolution, fps);
    }
  } catch (error) {
    console.error('[recorder] failed to start', error);
    await stopAllRecorders();
    ipcRenderer.invoke('recorder-failed', { error: error?.message || String(error) }).catch(() => { });
  }
});

ipcRenderer.on('recorder-stop', async () => {
  try {
    await stopAllRecorders();
  } catch (err) {
    console.warn('[recorder] stopAll failed', err);
  }
});

ipcRenderer.on('recorder-stop-and-flush', async (_event, payload = {}) => {
  try {
    nextSaveMeta = payload || null;
    await stopAndFlushAllRecorders();
  } catch (err) {
    console.warn('[recorder] stop-and-flush failed', err);
  } finally {
    nextSaveMeta = null;
    try {
      ipcRenderer.send('recorder-flushed');
    } catch (e) {
      console.warn('[recorder] failed to notify flushed', e);
    }
  }
});
