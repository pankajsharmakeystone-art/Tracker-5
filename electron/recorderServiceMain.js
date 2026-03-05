const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');

// Use a dedicated profile path for recorder service to avoid lock/contention
// with the main desktop process cache directories.
const serviceProfilePath = path.join(app.getPath('userData'), 'profile');
const serviceSessionPath = path.join(serviceProfilePath, 'session-data');
fs.mkdirSync(serviceSessionPath, { recursive: true });
app.setPath('sessionData', serviceSessionPath);

const RECORDINGS_DIR = String(process.env.RECORDER_RECORDINGS_DIR || '').trim() || path.join(app.getPath('userData'), 'recordings');
const TEMP_RECORDINGS_DIR = String(process.env.RECORDER_TEMP_RECORDINGS_DIR || '').trim() || path.join(app.getPath('userData'), 'recordings_temp');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
fs.mkdirSync(TEMP_RECORDINGS_DIR, { recursive: true });

const activeRecordingHandles = new Map();
const WEBM_EBML_HEADER = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
const MAX_HEADER_SCAN_BYTES = 512 * 1024;

let recorderWindow = null;
let commandQueue = Promise.resolve();
let startCommandInFlight = false;

function send(msg) {
  try {
    if (typeof process.send === 'function') {
      process.send(msg);
      return;
    }
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch (_) { }
}

function log(...args) {
  send({ type: 'log', level: 'info', args });
}

function toNodeBuffer(chunkBuffer) {
  if (!chunkBuffer) return null;
  if (Buffer.isBuffer(chunkBuffer)) return chunkBuffer;
  if (chunkBuffer instanceof ArrayBuffer) return Buffer.from(chunkBuffer);
  if (ArrayBuffer.isView(chunkBuffer)) return Buffer.from(chunkBuffer.buffer, chunkBuffer.byteOffset, chunkBuffer.byteLength);
  if (chunkBuffer?.type === 'Buffer' && Array.isArray(chunkBuffer?.data)) return Buffer.from(chunkBuffer.data);
  if (Array.isArray(chunkBuffer)) return Buffer.from(chunkBuffer);
  throw new Error(`unsupported-chunk-type:${Object.prototype.toString.call(chunkBuffer)}`);
}

function createRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) return recorderWindow;
  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'recorderPreload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false
    }
  });
  recorderWindow.loadFile(path.join(__dirname, 'recorder.html'));
  recorderWindow.on('closed', () => {
    recorderWindow = null;
  });
  return recorderWindow;
}

async function waitForRecorderWindowReady(timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!recorderWindow || recorderWindow.isDestroyed()) return resolve(false);
    const wc = recorderWindow.webContents;
    if (!wc || wc.isDestroyed()) return resolve(false);
    if (!wc.isLoadingMainFrame()) return resolve(true);
    const timer = setTimeout(() => {
      wc.removeListener('did-finish-load', onReady);
      resolve(false);
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onReady);
      resolve(true);
    };
    wc.once('did-finish-load', onReady);
  });
}

function enqueueCommand(work) {
  commandQueue = commandQueue.then(() => work()).catch((e) => {
    log('[service] command failed', e?.message || e);
  });
  return commandQueue;
}

function withCommandIdPayload(id, payload = {}) {
  const base = (payload && typeof payload === 'object') ? payload : {};
  return { ...base, __commandId: id };
}

function handleCommand(msg) {
  const id = String(msg?.id || '');
  const action = String(msg?.action || '');
  const payload = (msg?.payload && typeof msg.payload === 'object') ? msg.payload : {};
  if (!id || !action) return;

  if (action === 'start') {
    log('[service-start][debug] received', {
      id,
      inFlight: startCommandInFlight,
      hasWindow: Boolean(recorderWindow && !recorderWindow.isDestroyed())
    });
    if (startCommandInFlight) {
      log('[service-start][debug] deduped', { id });
      send({ type: 'ack', id, ok: true, deduped: true });
      return;
    }
    startCommandInFlight = true;
    (async () => {
      try {
        createRecorderWindow();
        const ready = await waitForRecorderWindowReady(10000);
        log('[service-start][debug] window-ready-check', { id, ready });
        if (!ready || !recorderWindow || recorderWindow.isDestroyed()) {
          throw new Error('recorder-window-not-ready');
        }
        recorderWindow.webContents.send('recorder-start', withCommandIdPayload(id, payload));
        log('[service-start][debug] sent-recorder-start', { id });
        send({ type: 'ack', id, ok: true });
      } catch (e) {
        log('[service-start][debug] failed', { id, error: e?.message || String(e) });
        send({ type: 'ack', id, ok: false, error: e?.message || String(e) });
      } finally {
        startCommandInFlight = false;
      }
    })();
    return;
  }

  enqueueCommand(async () => {
    try {
      createRecorderWindow();
      const ready = await waitForRecorderWindowReady(10000);
      if (!ready || !recorderWindow || recorderWindow.isDestroyed()) {
        throw new Error('recorder-window-not-ready');
      }

      if (action === 'stop') {
        recorderWindow.webContents.send('recorder-stop', withCommandIdPayload(id, payload));
        send({ type: 'ack', id, ok: true });
        return;
      }
      if (action === 'stopAndFlush') {
        await new Promise((resolve, reject) => {
          // Keep service queue responsive: do not let stopAndFlush block for a full minute.
          // Preload now has forced-finalize fallback, so a bounded timeout is safe here.
          const requestedTimeoutMs = Number.isFinite(payload?.timeoutMs) ? Number(payload.timeoutMs) : 60000;
          const timeoutMs = Math.max(10000, Math.min(requestedTimeoutMs, 20000));
          let settled = false;
          const payloadWithId = withCommandIdPayload(id, payload);
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ipcMain.removeListener('recorder-flushed', onFlushed);
            ipcMain.removeListener('recorder-command-ack', onCommandAck);
            reject(new Error('flush-timeout'));
          }, timeoutMs);
          const onCommandAck = (_event, ackPayload = {}) => {
            const commandId = String(ackPayload?.commandId || '');
            if (commandId !== id || settled) return;
            const phase = String(ackPayload?.phase || '').toLowerCase();
            if (phase === 'received') return;
            settled = true;
            clearTimeout(timer);
            ipcMain.removeListener('recorder-flushed', onFlushed);
            ipcMain.removeListener('recorder-command-ack', onCommandAck);
            if (phase === 'failed') {
              reject(new Error(String(ackPayload?.error || 'stop-and-flush-failed')));
              return;
            }
            resolve();
          };
          const onFlushed = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ipcMain.removeListener('recorder-flushed', onFlushed);
            ipcMain.removeListener('recorder-command-ack', onCommandAck);
            resolve();
          };
          ipcMain.on('recorder-command-ack', onCommandAck);
          ipcMain.on('recorder-flushed', onFlushed);
          recorderWindow.webContents.send('recorder-stop-and-flush', payloadWithId);
        });
        send({ type: 'ack', id, ok: true });
        return;
      }

      throw new Error(`unknown-action:${action}`);
    } catch (e) {
      send({ type: 'ack', id, ok: false, error: e?.message || String(e) });
    }
  });
}

ipcMain.handle('recorder-get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    return {
      success: true,
      sources: (sources || []).map((s) => ({ id: s.id, name: s.name }))
    };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('recorder-create-temp-file', async (_event, sourceId, sourceName) => {
  try {
    const existing = activeRecordingHandles.get(sourceId);
    if (existing) return { success: false, error: 'source-busy' };
    const safeName = String(sourceName || 'screen').replace(/[^a-z0-9_\-]/gi, '_');
    const tempFileName = `temp-${safeName}-${Date.now()}.webm`;
    const tempPath = path.join(TEMP_RECORDINGS_DIR, tempFileName);
    const fd = fs.openSync(tempPath, 'w');
    activeRecordingHandles.set(sourceId, {
      fd,
      tempPath,
      bytesWritten: 0,
      sourceName: safeName,
      closing: false,
      closed: false,
      headerFound: false,
      headerScanBuffer: Buffer.alloc(0),
      droppedPrefixBytes: 0
    });
    return { success: true, tempPath };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('recorder-append-chunk', async (_event, sourceId, chunkBuffer) => {
  try {
    const handle = activeRecordingHandles.get(sourceId);
    if (!handle) return { success: false, error: 'no-active-handle' };
    if (handle.closing || handle.closed) return { success: true, bytesWritten: handle.bytesWritten, ignoredBecauseClosing: true };
    let buffer = toNodeBuffer(chunkBuffer);
    if (!buffer || buffer.length === 0) return { success: true, bytesWritten: handle.bytesWritten, skippedEmpty: true };

    if (!handle.headerFound) {
      if (handle.headerScanBuffer && handle.headerScanBuffer.length > 0) {
        buffer = Buffer.concat([handle.headerScanBuffer, buffer]);
      }
      const headerIndex = buffer.indexOf(WEBM_EBML_HEADER);
      if (headerIndex === -1) {
        if (buffer.length > MAX_HEADER_SCAN_BYTES) {
          handle.headerScanBuffer = buffer.slice(-MAX_HEADER_SCAN_BYTES);
        } else {
          handle.headerScanBuffer = buffer;
        }
        return { success: true, bytesWritten: handle.bytesWritten, awaitingHeader: true };
      }
      buffer = buffer.slice(Math.max(0, headerIndex));
      handle.headerFound = true;
      handle.headerScanBuffer = Buffer.alloc(0);
    }

    fs.writeSync(handle.fd, buffer);
    handle.bytesWritten += buffer.length;
    return { success: true, bytesWritten: handle.bytesWritten };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('recorder-finalize', async (_event, sourceId, meta = {}) => {
  const handle = activeRecordingHandles.get(sourceId);
  if (!handle) return { success: false, error: 'no-active-handle' };
  try {
    handle.closing = true;
    fs.closeSync(handle.fd);
    handle.closed = true;

    if (!handle.headerFound) {
      try { await fs.promises.unlink(handle.tempPath); } catch (_) { }
      activeRecordingHandles.delete(sourceId);
      return { success: false, error: 'missing-webm-header' };
    }

    const finalFileName = `recording-${handle.sourceName}-${Date.now()}.webm`;
    const finalPath = path.join(RECORDINGS_DIR, finalFileName);
    await fs.promises.rename(handle.tempPath, finalPath);
    activeRecordingHandles.delete(sourceId);
    const stat = await fs.promises.stat(finalPath);

    send({
      type: 'event',
      name: 'segment-finalized',
      payload: {
        fileName: finalFileName,
        filePath: finalPath,
        bytes: stat.size,
        sourceName: handle.sourceName,
        durationMs: Number(meta?.durationMs || 0) || null,
        stopReason: meta?.stopReason || null
      }
    });

    return { success: true, filePath: finalPath, fileName: finalFileName, bytes: stat.size };
  } catch (e) {
    activeRecordingHandles.delete(sourceId);
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('recorder-save', async (_event, fileName, arrayBuffer, meta = {}) => {
  try {
    const safeFileName = String(fileName || `recording-screen-${Date.now()}.webm`).replace(/[\\/:*?"<>|]/g, '-');
    const finalPath = path.join(RECORDINGS_DIR, safeFileName);
    const buffer = Buffer.from(arrayBuffer);
    await fs.promises.writeFile(finalPath, buffer);
    const stat = await fs.promises.stat(finalPath);
    send({
      type: 'event',
      name: 'segment-finalized',
      payload: {
        fileName: safeFileName,
        filePath: finalPath,
        bytes: stat.size,
        sourceName: null,
        durationMs: Number(meta?.durationMs || 0) || null,
        stopReason: meta?.stopReason || null
      }
    });
    return { success: true, filePath: finalPath };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('recorder-diagnostic', async (_event, payload = {}) => {
  send({ type: 'event', name: 'diagnostic', payload: payload || {} });
  return { success: true };
});

ipcMain.handle('recorder-failed', async (_event, payload = {}) => {
  send({ type: 'event', name: 'failed', payload: payload || {} });
  return { success: true };
});

ipcMain.on('recorder-state-event', (_event, payload = {}) => {
  send({ type: 'event', name: 'state', payload: payload || {} });
});

ipcMain.on('recorder-command-ack', (_event, payload = {}) => {
  const commandId = String(payload?.commandId || '');
  if (commandId) {
    log('[service-start][debug] recorder-command-ack', {
      commandId,
      phase: String(payload?.phase || ''),
      error: payload?.error || null
    });
  }
  send({ type: 'event', name: 'command-ack', payload: payload || {} });
});

app.whenReady().then(() => {
  createRecorderWindow();
  send({ type: 'ready' });
});

function handleInboundStdinLine(rawLine) {
  const raw = String(rawLine || '').trim();
  if (!raw) return;
  log('[ipc][debug] stdin-line', {
    length: raw.length,
    preview: raw.slice(0, 160)
  });
  try {
    const msg = JSON.parse(raw);
    if (msg?.type === 'cmd') {
      handleCommand(msg);
      return;
    }
    if (msg?.type === 'shutdown') {
      app.quit();
    }
  } catch (e) {
    log('[ipc][debug] stdin-parse-failed', {
      error: e?.message || String(e),
      length: raw.length,
      preview: raw.slice(0, 160)
    });
  }
}

function handleInboundMessage(msg) {
  try {
    if (!msg || typeof msg !== 'object') return;
    if (msg?.type === 'cmd') {
      log('[ipc][debug] message-cmd', { action: msg?.action || null, id: msg?.id || null });
      handleCommand(msg);
      return;
    }
    if (msg?.type === 'shutdown') {
      app.quit();
    }
  } catch (e) {
    log('[ipc][debug] message-handle-failed', e?.message || String(e));
  }
}

// Use explicit stream parsing instead of readline; this is more reliable for
// Electron child-process stdio pipes on Windows.
let stdinBuffer = '';
try {
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    stdinBuffer += String(chunk || '');
    const lines = stdinBuffer.split(/\r?\n/);
    stdinBuffer = lines.pop() || '';
    for (const line of lines) {
      handleInboundStdinLine(line);
    }
  });
} catch (e) {
  log('[ipc][debug] stdin-init-failed', e?.message || String(e));
}

try {
  process.on('message', (msg) => {
    log('[ipc][debug] process-message', {
      type: msg?.type || null,
      action: msg?.action || null,
      id: msg?.id || null
    });
    handleInboundMessage(msg);
  });
} catch (e) {
  log('[ipc][debug] process-message-init-failed', e?.message || String(e));
}

process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
