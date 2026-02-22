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

function computeFrameFingerprint(ctx, width, height) {
  if (!ctx || !width || !height) return null;
  const sampleWidth = Math.min(64, width);
  const sampleHeight = Math.min(36, height);
  const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);
  const data = imageData?.data;
  if (!data || data.length === 0) return null;

  // Small quantized fingerprint for freeze detection.
  const buckets = [];
  const stepX = Math.max(1, Math.floor(sampleWidth / 8));
  const stepY = Math.max(1, Math.floor(sampleHeight / 6));
  for (let y = 0; y < sampleHeight; y += stepY) {
    for (let x = 0; x < sampleWidth; x += stepX) {
      const i = (y * sampleWidth + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = Math.floor(((r + g + b) / 3) / 16);
      buckets.push(lum.toString(16));
    }
  }
  return buckets.join('');
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

  // Analysis canvas is only for health checks. Recording uses raw capture stream.
  const analysisCanvas = document.createElement('canvas');
  analysisCanvas.width = Math.min(640, width || 640);
  analysisCanvas.height = Math.min(360, height || 360);
  const analysisCtx = analysisCanvas.getContext('2d');
  if (!analysisCtx) throw new Error('Failed to get analysis canvas context');

  await video.play().catch(() => {
    // autoplay may be blocked; draw loop will still attempt
  });

  let mutedSinceMs = null;
  let runtimeConsecutiveDrawFailures = 0;
  let runtimeConsecutiveBlackSamples = 0;
  let monitorTick = 0;
  let lastFrameCallbackAt = Date.now();
  let monitorTimer = null;
  let lastFingerprint = null;
  let sameFingerprintChecks = 0;
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
    const probe = await validateInitialFrames(video, analysisCanvas, analysisCtx);
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

  if (typeof video.requestVideoFrameCallback === 'function') {
    const onFrame = () => {
      lastFrameCallbackAt = Date.now();
      if (video && video.srcObject) {
        try { video.requestVideoFrameCallback(onFrame); } catch (_) { }
      }
    };
    try { video.requestVideoFrameCallback(onFrame); } catch (_) { }
  }

  const monitorCaptureHealth = () => {
    if (!analysisCtx) return;
    try {
      analysisCtx.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
      runtimeConsecutiveDrawFailures = 0;

      monitorTick += 1;
      if (monitorTick % 2 === 0) {
        if (mutedSinceMs && (Date.now() - mutedSinceMs) > 8000) {
          reportSourceFailure('input-track-muted-too-long', {
            mutedForMs: Date.now() - mutedSinceMs
          }).catch(() => { });
        }
        if (isLikelyBlackFrame(analysisCtx, analysisCanvas.width, analysisCanvas.height)) {
          runtimeConsecutiveBlackSamples += 1;
        } else {
          runtimeConsecutiveBlackSamples = 0;
        }
        if (runtimeConsecutiveBlackSamples >= 10) {
          reportSourceFailure('runtime-black-frames', {
            blackSamplesInRow: runtimeConsecutiveBlackSamples
          }).catch(() => { });
        }

        const fingerprint = computeFrameFingerprint(analysisCtx, analysisCanvas.width, analysisCanvas.height);
        if (fingerprint && fingerprint === lastFingerprint) {
          sameFingerprintChecks += 1;
        } else {
          sameFingerprintChecks = 0;
          lastFingerprint = fingerprint;
        }

        // Detect long-running frozen image (not necessarily black).
        // Runs every ~2s; threshold 90 ~= 3 minutes.
        if (sameFingerprintChecks >= 90) {
          reportSourceFailure('runtime-stale-frame-detected', {
            staleForApproxSeconds: sameFingerprintChecks * 2
          }).catch(() => { });
        }
      }
    } catch (e) {
      runtimeConsecutiveDrawFailures += 1;
      if (runtimeConsecutiveDrawFailures >= 12) {
        reportSourceFailure('runtime-draw-failed', {
          drawFailureCount: runtimeConsecutiveDrawFailures,
          error: e?.message || String(e)
        }).catch(() => { });
      }
      console.warn('[recorder] draw failed', e?.message || e);
    }

    // Detect frozen capture pipeline even when pixels are unchanged.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const msSinceLastFrame = Date.now() - lastFrameCallbackAt;
      if (msSinceLastFrame > 20000) {
        reportSourceFailure('runtime-frame-callback-timeout', {
          msSinceLastFrame
        }).catch(() => { });
      }
    }
  };

  monitorTimer = setInterval(monitorCaptureHealth, 1000);

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
  const selectedMimeType = MediaRecorder.isTypeSupported(mimeType)
    ? mimeType
    : (MediaRecorder.isTypeSupported('video/webm; codecs=vp8') ? 'video/webm; codecs=vp8' : 'video/webm');
  const options = { mimeType: selectedMimeType };

  const mediaRecorder = new MediaRecorder(inputStream, options);
  const instanceId = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
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
      throw new Error(createRes?.error || 'create-temp-failed');
    }
  } catch (err) {
    console.warn('[recorder] Temp file creation failed', err);
    inputStream.getTracks?.().forEach((t) => t.stop());
    throw err;
  }

  // Store session data (no more recordedChunks array for memory mode)
  const sessionRecord = {
    instanceId,
    mediaRecorder,
    stream: inputStream,
    sourceName: label,
    finalizePromise,
    startTime,
    tempFileReady,
    pendingChunks: tempFileReady ? null : [],  // Only use if temp file failed
    finalizeResolve,
    monitorTimer,
    video
  };
  sessions.set(id, sessionRecord);

  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;

    const session = sessions.get(id);
    if (!session || session.instanceId !== instanceId) return;

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
    try {
      const isLastSession = sessions.size === 1;
      const durationMs = sessionRecord.startTime ? (Date.now() - sessionRecord.startTime) : null;
      const saveMeta = { isLastSession, durationMs, ...(nextSaveMeta || {}) };

      if (sessionRecord.tempFileReady) {
        // Finalize: close file, move to recordings, trigger upload
        console.log('[recorder] Finalizing incremental recording for', id);
        ipcRenderer.invoke('recorder-finalize', id, saveMeta)
          .catch((err) => console.error('[recorder] finalize failed', err));
      } else if (sessionRecord.pendingChunks && sessionRecord.pendingChunks.length > 0) {
        // Fallback: use old memory-based approach (for small recordings or failures)
        console.log('[recorder] Using fallback memory-based save for', id);
        const blob = new Blob(sessionRecord.pendingChunks, { type: 'video/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        const safeName = sanitizeName(sessionRecord.sourceName || 'screen');
        const fileName = `recording-${safeName}-${Date.now()}.webm`;
        ipcRenderer.invoke('recorder-save', fileName, arrayBuffer, saveMeta)
          .catch((err) => console.error('[recorder] failed to send recording', err));
      }
    } catch (err) {
      console.error('[recorder] failed to finalize recording', err);
    } finally {
      try {
        if (sessionRecord?.monitorTimer) clearInterval(sessionRecord.monitorTimer);
        if (sessionRecord?.video) sessionRecord.video.srcObject = null;
        sessionRecord?.stream?.getTracks()?.forEach((t) => t.stop());
      } catch (e) { }
      const active = sessions.get(id);
      if (active && active.instanceId === instanceId) {
        sessions.delete(id);
      }
      if (sessions.size === 0) {
        try {
          ipcRenderer.send('recorder-state-event', { state: 'idle', reason: 'all_sessions_stopped' });
        } catch (_) { }
      }
      sessionRecord?.finalizeResolve?.();
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

    try {
      ipcRenderer.send('recorder-state-event', {
        state: 'recording',
        sourceCount: startedCount,
        failedSourceCount: startFailures.length
      });
    } catch (_) { }

    if (startFailures.length > 0) {
      console.warn('[recorder] some display sources failed to start', startFailures);
    }
  } catch (error) {
    console.error('[recorder] failed to start', error);
    await stopAllRecorders();
    try {
      ipcRenderer.send('recorder-state-event', { state: 'idle', reason: 'start_failed' });
    } catch (_) { }
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
    if (sessions.size === 0) {
      try {
        ipcRenderer.send('recorder-state-event', { state: 'idle', reason: 'stop_and_flush' });
      } catch (_) { }
    }
    try {
      ipcRenderer.send('recorder-flushed');
    } catch (e) {
      console.warn('[recorder] failed to notify flushed', e);
    }
  }
});
