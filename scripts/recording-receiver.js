const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');

const pump = promisify(pipeline);

const PORT = Number(process.env.RECORDING_RECEIVER_PORT || 5055);
const BASE_DIR = process.env.RECORDING_RECEIVER_PATH || 'D:\\Recordings';
const TOKEN = process.env.RECORDING_RECEIVER_TOKEN || '';

const sanitizeSegment = (value, fallback = 'unknown') => {
  const clean = String(value || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim();
  return clean || fallback;
};

const normalizeIsoDate = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const buildTargetPath = ({ agentName, isoDate, fileName }) => {
  const safeAgent = sanitizeSegment(agentName, 'agent');
  const safeDate = sanitizeSegment(isoDate || 'unknown-date', 'unknown-date');
  const safeFile = sanitizeSegment(fileName, `recording-${Date.now()}.webm`);
  const folder = path.join(BASE_DIR, safeAgent, safeDate);
  return { folder, targetPath: path.join(folder, safeFile) };
};

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload || {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, message: 'Recording receiver running.' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method-not-allowed' });
    return;
  }

  if (TOKEN) {
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${TOKEN}`;
    if (auth !== expected) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
  }

  const agentName = req.headers['x-agent-name'];
  const fileName = req.headers['x-file-name'];
  const isoDate = normalizeIsoDate(req.headers['x-iso-date']) || new Date().toISOString().slice(0, 10);

  // Chunking headers
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
  const totalChunks = parseInt(req.headers['x-total-chunks'], 10);
  const totalSize = parseInt(req.headers['x-file-size'], 10);
  const chunkHash = req.headers['x-chunk-hash'];

  const { folder, targetPath } = buildTargetPath({ agentName, isoDate, fileName });

  try {
    await fs.promises.mkdir(folder, { recursive: true });

    const isFirstChunk = isNaN(chunkIndex) || chunkIndex === 0;
    const isLastChunk = isNaN(totalChunks) || chunkIndex === totalChunks - 1;

    // We'll read the chunk into memory if we need to verify hash, 
    // or just pipe it. Since chunks are 10MB, memory is fine.
    let chunkBuffer;
    if (chunkHash) {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      chunkBuffer = Buffer.concat(chunks);

      const actualHash = crypto.createHash('md5').update(chunkBuffer).digest('hex');
      if (actualHash !== chunkHash) {
        console.error(`[recording-receiver] Chunk hash mismatch for ${fileName} chunk ${chunkIndex}. Expected ${chunkHash}, got ${actualHash}`);
        return sendJson(res, 400, { success: false, error: 'chunk-hash-mismatch' });
      }
    }

    // Use 'w' (write/overwrite) for first chunk, 'a' (append) for subsequent ones
    if (chunkBuffer) {
      await fs.promises.appendFile(targetPath, chunkBuffer, { flag: isFirstChunk ? 'w' : 'a' });
    } else {
      const writeStream = fs.createWriteStream(targetPath, { flags: isFirstChunk ? 'w' : 'a' });
      await pump(req, writeStream);
    }

    // Final integrity check on the last chunk
    if (isLastChunk && !isNaN(totalSize)) {
      const stats = await fs.promises.stat(targetPath);
      if (stats.size !== totalSize) {
        console.error(`[recording-receiver] Integrity check failed for ${fileName}. Expected ${totalSize}, got ${stats.size}`);
        return sendJson(res, 400, {
          success: false,
          error: 'integrity-check-failed',
          expectedSize: totalSize,
          actualSize: stats.size
        });
      }
      console.log(`[recording-receiver] Successfully received and verified ${fileName} (${stats.size} bytes)`);
    } else if (!isNaN(chunkIndex)) {
      console.log(`[recording-receiver] Received chunk ${chunkIndex + 1}/${totalChunks || '?'} for ${fileName}`);
    }

    sendJson(res, 200, {
      success: true,
      path: targetPath,
      receivedChunk: isNaN(chunkIndex) ? null : chunkIndex,
      completed: isLastChunk
    });
  } catch (error) {
    console.error(`[recording-receiver] Error processing ${fileName}:`, error);
    sendJson(res, 500, { success: false, error: error?.message || 'write-failed' });
  }
});

// Disable timeouts to support large/slow uploads
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(PORT, () => {
  console.log(`[recording-receiver] Listening on port ${PORT}`);
  console.log(`[recording-receiver] Saving to ${BASE_DIR}`);
  console.log(`[recording-receiver] Timeouts disabled (infinite)`);
});
