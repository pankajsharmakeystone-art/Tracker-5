const { ipcRenderer, desktopCapturer } = require('electron');

// Minimal recorder that lives in a hidden window. It records all screen sources and
// streams chunks directly to disk to support 2GB+ files without memory issues.

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

const pad2 = (value) => String(value).padStart(2, '0');

const formatTimestamp = (date = new Date()) => {
  const dd = pad2(date.getDate());
  const mm = pad2(date.getMonth() + 1);
  const yyyy = date.getFullYear();
  const HH = pad2(date.getHours());
  const MM = pad2(date.getMinutes());
  const SS = pad2(date.getSeconds());
  return `${dd}/${mm}/${yyyy}  ${HH}:${MM}:${SS}`;
};

const deriveScreenLabel = (source, index = 0) => {
  const name = String(source?.name || '').trim();
  const match = name.match(/(?:screen|display|monitor)\s*([0-9]+)/i);
  if (match) return `screen${match[1]}`;
  return `screen${index + 1}`;
};

async function startRecorderForSource(source, resolution, fps, labelOverride) {
  const { id, name } = source;
  const constraints = buildConstraints(id, resolution, fps);
  const mediaDevices = navigator.mediaDevices;
  const legacyGetUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)?.bind(navigator);
  const getUserMediaFn = (mediaDevices && mediaDevices.getUserMedia) ? mediaDevices.getUserMedia.bind(mediaDevices) : legacyGetUserMedia;

  if (!getUserMediaFn) {
    console.error('[recorder] mediaDevices missing in recorder window');
    throw new Error('getUserMedia unavailable in recorder window');
  }

  const inputStream = await getUserMediaFn(constraints);
  const videoTrack = inputStream.getVideoTracks?.()[0];
  const trackSettings = videoTrack?.getSettings ? videoTrack.getSettings() : {};
  const width = resolution?.width || trackSettings.width || 1280;
  const height = resolution?.height || trackSettings.height || 720;

  const video = document.createElement('video');
  video.srcObject = inputStream;
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  await video.play().catch(() => {
    // autoplay may be blocked; draw loop will still attempt
  });

  const draw = () => {
    if (!ctx) return;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const fontSize = Math.max(18, Math.round(canvas.width * 0.018));
      ctx.font = `${fontSize}px Arial`;
      ctx.textBaseline = 'top';

      const text = formatTimestamp(new Date());
      const padding = Math.max(6, Math.round(fontSize * 0.4));
      const textWidth = ctx.measureText(text).width;
      const boxWidth = textWidth + padding * 2;
      const boxHeight = fontSize + padding * 1.4;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(10, 10, boxWidth, boxHeight);

      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(text, 10 + padding, 10 + padding * 0.7);
    } catch (e) {
      console.warn('[recorder] draw failed', e?.message || e);
    }
  };

  let drawTimer = null;
  const frameInterval = Math.max(250, Math.round(1000 / (fps || 30)));
  drawTimer = setInterval(draw, frameInterval);

  const canvasStream = canvas.captureStream(fps || 30);

  const mimeType = 'video/webm; codecs=vp9';
  const options = {
    mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'video/webm'
  };

  const mediaRecorder = new MediaRecorder(canvasStream, options);
  let finalizeResolve;
  const finalizePromise = new Promise((resolve) => { finalizeResolve = resolve; });
  const startTime = Date.now();

  // Create temp file for incremental writes (streaming to disk)
  let tempFileReady = false;
  let pendingChunks = []; // Buffer chunks until temp file is ready

  const label = labelOverride || deriveScreenLabel(source, 0);

  try {
    const createRes = await ipcRenderer.invoke('recorder-create-temp-file', id, label);
    if (createRes?.success) {
      tempFileReady = true;
      console.log('[recorder] Temp file created for', id);

      // Flush any chunks that arrived before temp file was ready
      for (const pendingChunk of pendingChunks) {
        try {
          const arrayBuffer = await pendingChunk.arrayBuffer();
          await ipcRenderer.invoke('recorder-append-chunk', id, arrayBuffer);
        } catch (e) {
          console.warn('[recorder] Failed to flush pending chunk', e);
        }
      }
      pendingChunks = [];
    } else {
      console.warn('[recorder] Failed to create temp file, falling back to memory mode');
    }
  } catch (err) {
    console.warn('[recorder] Temp file creation failed, falling back to memory mode', err);
  }

  // Store session data (no more recordedChunks array for memory mode)
  sessions.set(id, {
    mediaRecorder,
    stream: inputStream,
    sourceName: label,
    finalizePromise,
    startTime,
    tempFileReady,
    pendingChunks: tempFileReady ? null : [],  // Only use if temp file failed
    finalizeResolve,
    drawTimer,
    canvasStream
  });

  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;

    const session = sessions.get(id);
    if (!session) return;

    if (session.tempFileReady) {
      // Stream directly to disk via IPC
      try {
        const arrayBuffer = await event.data.arrayBuffer();
        await ipcRenderer.invoke('recorder-append-chunk', id, arrayBuffer);
      } catch (err) {
        console.warn('[recorder] Failed to append chunk to disk', err);
      }
    } else if (session.pendingChunks) {
      // Fallback: buffer in memory (for legacy support or if temp file creation fails)
      session.pendingChunks.push(event.data);
    }
  };

  mediaRecorder.onerror = (event) => {
    console.error('[recorder] error', event?.error || event);
  };

  mediaRecorder.onstop = async () => {
    const session = sessions.get(id);
    try {
      if (!session) return;

      const isLastSession = sessions.size === 1;
      const durationMs = session.startTime ? (Date.now() - session.startTime) : null;
      const saveMeta = { isLastSession, durationMs, ...(nextSaveMeta || {}) };

      if (session.tempFileReady) {
        // Finalize: close file, move to recordings, trigger upload
        console.log('[recorder] Finalizing incremental recording for', id);
        ipcRenderer.invoke('recorder-finalize', id, saveMeta)
          .catch((err) => console.error('[recorder] finalize failed', err));
      } else if (session.pendingChunks && session.pendingChunks.length > 0) {
        // Fallback: use old memory-based approach (for small recordings or failures)
        console.log('[recorder] Using fallback memory-based save for', id);
        const blob = new Blob(session.pendingChunks, { type: 'video/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const safeName = sanitizeName(session.sourceName || 'screen');
        const fileName = `recording-${safeName}-${Date.now()}.webm`;
        ipcRenderer.invoke('recorder-save', fileName, arrayBuffer, saveMeta)
          .catch((err) => console.error('[recorder] failed to send recording', err));
      }
    } catch (err) {
      console.error('[recorder] failed to finalize recording', err);
    } finally {
      try {
        if (session?.drawTimer) clearInterval(session.drawTimer);
        session?.canvasStream?.getTracks?.()?.forEach((t) => t.stop());
        session?.stream?.getTracks()?.forEach((t) => t.stop());
      } catch (e) { }
      sessions.delete(id);
      session?.finalizeResolve?.();
    }
  };

  // Start with 1 second timeslice for frequent chunk writes
  mediaRecorder.start(1000);
  console.log('[recorder] started', name, id, 'incremental:', tempFileReady);
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

    for (let index = 0; index < targets.length; index += 1) {
      const src = targets[index];
      const label = deriveScreenLabel(src, index);
      await startRecorderForSource(src, resolution, fps, label);
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
