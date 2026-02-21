const { ipcRenderer, desktopCapturer } = require('electron');

// Minimal recorder that lives in a hidden window. It records all screen sources and
// streams chunks directly to disk to support 2GB+ files without memory issues.

const sessions = new Map();
let nextSaveMeta = null;
let fatalRecorderFailureInFlight = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const sourceDiagnostics = (source, trackSettings, extra = {}) => ({
  sourceId: source?.id || null,
  sourceName: source?.name || null,
  trackWidth: trackSettings?.width || null,
  trackHeight: trackSettings?.height || null,
  trackFrameRate: trackSettings?.frameRate || null,
  ...extra
});

async function reportFatalRecorderFailure(errorMessage, payload = {}) {
  if (fatalRecorderFailureInFlight) return;
  fatalRecorderFailureInFlight = true;
  try {
    try {
      await ipcRenderer.invoke('recorder-diagnostic', {
        type: 'runtime_capture_failure',
        error: errorMessage,
        ...payload
      });
    } catch (_) { }
    try {
      await stopAllRecorders();
    } catch (_) { }
    await ipcRenderer.invoke('recorder-failed', {
      error: errorMessage,
      ...payload
    });
  } catch (_) {
    // no-op
  } finally {
    // Allow another fatal signal only after a small cooldown.
    setTimeout(() => {
      fatalRecorderFailureInFlight = false;
    }, 4000);
  }
}

function isLikelyBlackFrame(ctx, width, height) {
  if (!ctx || !width || !height) return true;
  const sampleWidth = 64;
  const sampleHeight = 36;
  const imageData = ctx.getImageData(0, 0, Math.min(sampleWidth, width), Math.min(sampleHeight, height));
  const data = imageData?.data;
  if (!data || data.length === 0) return true;

  let nonBlackPixels = 0;
  const pixelCount = data.length / 4;
  const threshold = 24;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > threshold || g > threshold || b > threshold) nonBlackPixels += 1;
  }

  return (nonBlackPixels / pixelCount) < 0.01;
}

async function validateInitialFrames(video, canvas, ctx) {
  // Warm up a little to avoid classifying startup blank frame as a failure.
  await delay(350);
  const checks = 10;
  let blackSamples = 0;

  for (let i = 0; i < checks; i += 1) {
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (isLikelyBlackFrame(ctx, canvas.width, canvas.height)) {
        blackSamples += 1;
      }
    } catch (_) {
      blackSamples += 1;
    }
    await delay(120);
  }

  return { checks, blackSamples, blackRatio: blackSamples / checks };
}

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
  if (!ctx) throw new Error('Failed to get canvas 2d context');

  await video.play().catch(() => {
    // autoplay may be blocked; draw loop will still attempt
  });

  let mutedSinceMs = null;
  let runtimeConsecutiveDrawFailures = 0;
  let runtimeConsecutiveBlackSamples = 0;
  let runtimeTick = 0;
  let sourceFailureReported = false;

  const reportSourceFailure = async (reason, extra = {}) => {
    if (sourceFailureReported) return;
    sourceFailureReported = true;
    const payload = sourceDiagnostics(source, trackSettings, {
      requestedWidth: resolution?.width || null,
      requestedHeight: resolution?.height || null,
      requestedFps: fps || null,
      reason,
      ...extra
    });
    await reportFatalRecorderFailure(`black-screen-detected:${id}:${reason}`, payload);
  };

  try {
    const probe = await validateInitialFrames(video, canvas, ctx);
    if (probe.blackRatio >= 0.8) {
      try {
        await ipcRenderer.invoke('recorder-diagnostic', {
          type: 'black_screen_detected',
          ...sourceDiagnostics(source, trackSettings, {
            requestedWidth: resolution?.width || null,
            requestedHeight: resolution?.height || null,
            requestedFps: fps || null,
            checks: probe.checks,
            blackSamples: probe.blackSamples
          })
        });
      } catch (_) { }
      throw new Error(`black-screen-detected:${id}`);
    }
  } catch (probeErr) {
    inputStream.getTracks?.().forEach((t) => t.stop());
    throw probeErr;
  }

  const draw = () => {
    if (!ctx) return;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      runtimeConsecutiveDrawFailures = 0;

      runtimeTick += 1;
      if (runtimeTick % 12 === 0) {
        if (mutedSinceMs && (Date.now() - mutedSinceMs) > 8000) {
          reportSourceFailure('input-track-muted-too-long', {
            mutedForMs: Date.now() - mutedSinceMs
          }).catch(() => { });
        }
        if (isLikelyBlackFrame(ctx, canvas.width, canvas.height)) {
          runtimeConsecutiveBlackSamples += 1;
        } else {
          runtimeConsecutiveBlackSamples = 0;
        }
        if (runtimeConsecutiveBlackSamples >= 6) {
          reportSourceFailure('runtime-black-frames', {
            blackSamplesInRow: runtimeConsecutiveBlackSamples
          }).catch(() => { });
        }
      }

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
      runtimeConsecutiveDrawFailures += 1;
      if (runtimeConsecutiveDrawFailures >= 20) {
        reportSourceFailure('runtime-draw-failed', {
          drawFailureCount: runtimeConsecutiveDrawFailures,
          error: e?.message || String(e)
        }).catch(() => { });
      }
      console.warn('[recorder] draw failed', e?.message || e);
    }
  };

  let drawTimer = null;
  const frameInterval = Math.max(250, Math.round(1000 / (fps || 30)));
  drawTimer = setInterval(draw, frameInterval);

  const canvasStream = canvas.captureStream(fps || 30);
  const canvasTrack = canvasStream.getVideoTracks?.()[0];
  if (canvasTrack) {
    canvasTrack.onended = () => {
      reportSourceFailure('canvas-track-ended').catch(() => { });
    };
  }

  if (videoTrack) {
    videoTrack.onended = () => {
      reportSourceFailure('input-track-ended').catch(() => { });
    };
    videoTrack.onmute = () => {
      mutedSinceMs = Date.now();
    };
    videoTrack.onunmute = () => {
      mutedSinceMs = null;
    };
  }

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
          await ipcRenderer.invoke('recorder-append-chunk', id, new Uint8Array(arrayBuffer));
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
        await ipcRenderer.invoke('recorder-append-chunk', id, new Uint8Array(arrayBuffer));
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
    reportSourceFailure('mediarecorder-error', {
      error: event?.error?.message || String(event?.error || event)
    }).catch(() => { });
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
    fatalRecorderFailureInFlight = false;
    const quality = String(payload.recordingQuality || '720p');
    const fps = Number(payload.recordingFps || 30);
    const mapping = {
      '480p': { width: 640, height: 480 },
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 }
    };
    const resolution = mapping[quality] || mapping['720p'];
    const fallbackProfiles = [];
    const pushProfile = (res, candidateFps) => {
      const safeFps = Math.max(5, Math.min(60, Number(candidateFps) || 30));
      const key = `${res.width}x${res.height}@${safeFps}`;
      if (!fallbackProfiles.some((p) => p.key === key)) {
        fallbackProfiles.push({ key, resolution: res, fps: safeFps });
      }
    };

    pushProfile(resolution, fps);
    pushProfile(mapping['720p'], Math.min(24, fps || 24));
    pushProfile(mapping['480p'], 15);

    const res = await ipcRenderer.invoke('recorder-get-sources');
    if (!res?.success) {
      throw new Error(res?.error || 'no-sources');
    }

    const sourcesResult = res.sources || [];
    const screenSources = sourcesResult.filter((src) => src.id?.startsWith('screen') || /screen/i.test(src.name));
    const targets = screenSources.length > 0 ? screenSources : sourcesResult;
    const startFailures = [];
    let startedCount = 0;

    for (let index = 0; index < targets.length; index += 1) {
      const src = targets[index];
      const label = deriveScreenLabel(src, index);
      let sourceStarted = false;
      let lastError = null;

      for (const profile of fallbackProfiles) {
        try {
          await startRecorderForSource(src, profile.resolution, profile.fps, label);
          sourceStarted = true;
          startedCount += 1;
          if (profile.key !== fallbackProfiles[0].key) {
            try {
              await ipcRenderer.invoke('recorder-diagnostic', {
                type: 'source_started_with_fallback_profile',
                sourceId: src.id,
                sourceName: src.name,
                profile: profile.key
              });
            } catch (_) { }
          }
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!sourceStarted) {
        const message = lastError?.message || String(lastError || 'unknown-start-error');
        startFailures.push({ sourceId: src.id, sourceName: src.name, error: message });
        try {
          await ipcRenderer.invoke('recorder-diagnostic', {
            type: 'source_start_failed_all_profiles',
            sourceId: src.id,
            sourceName: src.name,
            error: message
          });
        } catch (_) { }
      }
    }

    if (startedCount === 0) {
      const error = new Error(`all-sources-failed:${startFailures.map((f) => f.error).join('|')}`);
      error.failures = startFailures;
      throw error;
    }

    if (startFailures.length > 0) {
      console.warn('[recorder] some display sources failed to start', startFailures);
    }
  } catch (error) {
    console.error('[recorder] failed to start', error);
    await stopAllRecorders();
    ipcRenderer.invoke('recorder-failed', { error: error?.message || String(error) }).catch(() => { });
  }
});

ipcRenderer.on('recorder-stop', async () => {
  try {
    fatalRecorderFailureInFlight = false;
    await stopAllRecorders();
  } catch (err) {
    console.warn('[recorder] stopAll failed', err);
  }
});

ipcRenderer.on('recorder-stop-and-flush', async (_event, payload = {}) => {
  try {
    fatalRecorderFailureInFlight = false;
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
