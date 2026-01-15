const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');

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

  const { folder, targetPath } = buildTargetPath({ agentName, isoDate, fileName });

  try {
    await fs.promises.mkdir(folder, { recursive: true });
    const writeStream = fs.createWriteStream(targetPath);
    await pump(req, writeStream);
    sendJson(res, 200, { success: true, path: targetPath });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error?.message || 'write-failed' });
  }
});

server.listen(PORT, () => {
  console.log(`[recording-receiver] Listening on port ${PORT}`);
  console.log(`[recording-receiver] Saving to ${BASE_DIR}`);
});
