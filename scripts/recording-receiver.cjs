const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');

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
    ,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type'
  });
  res.end(body);
};

// ---------- FFMPEG FUNCTIONS ----------

// Find FFmpeg executable (supports both installed and bundled versions)
const findFfmpegPath = () => {
  // Check if ffmpeg-static is available
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch (_) { }

  // Fallback to system ffmpeg
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
};

const FFMPEG_PATH = findFfmpegPath();
console.log(`[recording-receiver] Using FFmpeg: ${FFMPEG_PATH}`);
const WEBM_EBML_HEADER = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);

// Fix WebM duration by remuxing through FFmpeg
// This adds proper duration metadata that MediaRecorder doesn't include
async function fixWebmDurationWithFfmpeg(inputPath) {
  return new Promise((resolve) => {
    const tempPath = inputPath + '.fixing.webm';

    const args = [
      '-y',                    // Overwrite output
      '-i', inputPath,         // Input file
      '-c', 'copy',            // Stream copy (no re-encoding)
      '-fflags', '+genpts',    // Generate presentation timestamps
      tempPath                 // Output file
    ];

    console.log(`[ffmpeg] Fixing duration for: ${path.basename(inputPath)}`);

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', async (code) => {
      if (code === 0 && fs.existsSync(tempPath)) {
        try {
          // Replace original with fixed version
          await fs.promises.unlink(inputPath);
          await fs.promises.rename(tempPath, inputPath);

          const stats = await fs.promises.stat(inputPath);
          console.log(`[ffmpeg] Duration fix complete: ${path.basename(inputPath)} (${stats.size} bytes)`);
          resolve({ success: true, size: stats.size });
        } catch (err) {
          console.error(`[ffmpeg] Failed to replace file:`, err.message);
          try { await fs.promises.unlink(tempPath); } catch (_) { }
          resolve({ success: false, error: err.message });
        }
      } else {
        console.error(`[ffmpeg] Fix failed (code ${code}):`, stderr.slice(-500));
        try { await fs.promises.unlink(tempPath); } catch (_) { }
        resolve({ success: false, error: `ffmpeg exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      console.error(`[ffmpeg] Spawn error:`, err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

// Remux WebM to a new output path without modifying the original
async function remuxWebmToOutput(inputPath, outputPath) {
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-i', inputPath,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      outputPath
    ];

    console.log(`[ffmpeg] Remuxing: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', async (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true });
      } else {
        console.error(`[ffmpeg] Remux failed (code ${code}):`, stderr.slice(-500));
        resolve({ success: false, error: stderr.slice(-500) || `ffmpeg exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      console.error(`[ffmpeg] Remux spawn error:`, err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

async function findEbmlHeaderOffset(filePath, maxScanBytes = 1024 * 1024) {
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stat = await fh.stat();
    const scanLimit = Math.min(Number(stat?.size || 0), maxScanBytes);
    if (!scanLimit || scanLimit < WEBM_EBML_HEADER.length) return -1;

    const chunkSize = 64 * 1024;
    let carry = Buffer.alloc(0);
    let position = 0;

    while (position < scanLimit) {
      const readLen = Math.min(chunkSize, scanLimit - position);
      const chunk = Buffer.alloc(readLen);
      const readResult = await fh.read(chunk, 0, readLen, position);
      if (!readResult || !readResult.bytesRead) break;

      const data = carry.length
        ? Buffer.concat([carry, chunk.slice(0, readResult.bytesRead)])
        : chunk.slice(0, readResult.bytesRead);
      const idx = data.indexOf(WEBM_EBML_HEADER);
      if (idx !== -1) {
        return position - carry.length + idx;
      }

      const keep = Math.max(0, WEBM_EBML_HEADER.length - 1);
      carry = keep > 0 && data.length > keep ? data.slice(data.length - keep) : data;
      position += readResult.bytesRead;
    }
    return -1;
  } catch (_) {
    return -1;
  } finally {
    if (fh) {
      try { await fh.close(); } catch (_) { }
    }
  }
}

async function trimWebmToOutput(inputPath, outputPath, offset) {
  if (!Number.isFinite(offset) || offset < 0) {
    return { success: false, error: 'invalid-offset' };
  }
  return new Promise((resolve) => {
    const read = fs.createReadStream(inputPath, { start: offset });
    const write = fs.createWriteStream(outputPath);
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    read.on('error', (err) => done({ success: false, error: err?.message || 'trim-read-failed' }));
    write.on('error', (err) => done({ success: false, error: err?.message || 'trim-write-failed' }));
    write.on('finish', () => done({ success: true }));
    read.pipe(write);
  });
}

// Merge multiple WebM segments into a single file
// Uses FFmpeg concat demuxer for lossless, fast merging
async function mergeSegments(segmentPaths, outputPath) {
  return new Promise(async (resolve) => {
    if (!segmentPaths || segmentPaths.length === 0) {
      return resolve({ success: false, error: 'no-segments' });
    }

    if (segmentPaths.length === 1) {
      // Only one segment, just copy it
      try {
        await fs.promises.copyFile(segmentPaths[0], outputPath);
        return resolve({ success: true, outputPath, segmentCount: 1 });
      } catch (err) {
        return resolve({ success: false, error: err.message });
      }
    }

    // Create concat list file
    const listPath = outputPath + '.concat.txt';
    const listContent = segmentPaths
      .map(p => p.replace(/\\/g, '/'))
      .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');

    try {
      await fs.promises.writeFile(listPath, listContent, 'utf8');
    } catch (err) {
      return resolve({ success: false, error: `Failed to create list file: ${err.message}` });
    }

    const args = [
      '-y',                    // Overwrite output
      '-f', 'concat',          // Concat demuxer
      '-safe', '0',            // Allow absolute paths
      '-i', listPath,          // Input list file
      '-c', 'copy',            // Stream copy (no re-encoding)
      '-fflags', '+genpts',    // Generate timestamps
      outputPath               // Output file
    ];

    console.log(`[ffmpeg] Merging ${segmentPaths.length} segments into: ${path.basename(outputPath)}`);

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', async (code) => {
      // Cleanup list file
      try { await fs.promises.unlink(listPath); } catch (_) { }

      if (code === 0 && fs.existsSync(outputPath)) {
        const stats = await fs.promises.stat(outputPath);
        console.log(`[ffmpeg] Merge complete: ${path.basename(outputPath)} (${stats.size} bytes, ${segmentPaths.length} segments)`);
        resolve({ success: true, outputPath, size: stats.size, segmentCount: segmentPaths.length });
      } else {
        console.error(`[ffmpeg] Merge failed (code ${code}):`, stderr.slice(-500));
        resolve({ success: false, error: `ffmpeg exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      console.error(`[ffmpeg] Spawn error:`, err.message);
      try { fs.promises.unlink(listPath); } catch (_) { }
      resolve({ success: false, error: err.message });
    });
  });
}

// Extract timestamp from filename: recording-Screen_1-1737829123456.webm → 1737829123456
function extractTimestamp(filename) {
  // Match 13-digit timestamp before .webm extension
  const match = filename.match(/(\d{13})\.webm$/);
  return match ? parseInt(match[1], 10) : 0;
}

// Extract screen identifier from filename
function extractScreenId(filename) {
  const base = filename
    .replace(/\.webm$/i, '')
    .replace(/-\d{13}$/i, '')
    .replace(/^recording-?/i, '');

  const screenPattern = /(?:screen|display|monitor)[-_]?(\d+)/i;
  const match = base.match(screenPattern);
  if (match) return `screen${match[1]}`;

  // If name indicates a screen but no numeric suffix, group as screen0
  if (/(screen|display|monitor)/i.test(base)) return 'screen0';

  return 'default';
}

async function isValidWebmHeader(filePath) {
  try {
    const fh = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(4);
    await fh.read(buffer, 0, 4, 0);
    await fh.close();
    return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  } catch (_) {
    return false;
  }
}

async function filterValidSegments(segments) {
  const valid = [];
  const invalid = [];
  for (const seg of segments) {
    const ok = await isValidWebmHeader(seg.path);
    if (ok) valid.push(seg);
    else invalid.push(seg);
  }
  if (invalid.length) {
    console.warn(`[recording-receiver] Skipping ${invalid.length} invalid WebM segment(s):`, invalid.map(s => s.name));
  }
  return { valid, invalid };
}

// Find all segment files for a given agent/date, optionally filtered by pattern
async function findSegments(agentName, isoDate, pattern = null) {
  const folder = path.join(BASE_DIR, sanitizeSegment(agentName, 'agent'), sanitizeSegment(isoDate, 'unknown-date'));

  try {
    const files = await fs.promises.readdir(folder);
    let segments = files
      .filter(f => f.endsWith('.webm'))
      .filter(f => !f.startsWith('merged-'))  // Exclude already-merged files
      .map(f => ({ name: f, path: path.join(folder, f), timestamp: extractTimestamp(f) }));

    if (pattern) {
      const regex = new RegExp(pattern, 'i');
      segments = segments.filter(s => regex.test(s.name));
    }

    // Deduplicate by screen + timestamp (in case same segment uploaded twice)
    const seen = new Map();
    segments = segments.filter(seg => {
      const screen = extractScreenId(seg.name);
      const key = `${screen}-${seg.timestamp}`;
      if (seen.has(key)) {
        console.log(`[recording-receiver] Skipping duplicate: ${seg.name}`);
        return false;
      }
      seen.set(key, true);
      return true;
    });

    // Sort by extracted timestamp (numeric, not string)
    segments.sort((a, b) => a.timestamp - b.timestamp);

    return { success: true, folder, segments };
  } catch (err) {
    return { success: false, error: err.message, folder, segments: [] };
  }
}


// Group segments by screen/display identifier
// Uses extractScreenId helper for consistent screen detection
function groupSegmentsByScreen(segments) {
  const groups = new Map();

  for (const segment of segments) {
    const screenId = extractScreenId(segment.name);

    if (!groups.has(screenId)) {
      groups.set(screenId, []);
    }
    groups.get(screenId).push(segment);
  }

  // Sort each group by timestamp (numeric, not string)
  for (const [key, segs] of groups) {
    segs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return groups;
}


const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // GET Endpoints
  if (req.method === 'GET') {
    // Health check: GET /
    if (pathname === '/' || pathname === '/health') {
      sendJson(res, 200, { ok: true, message: 'Recording receiver running.', ffmpeg: FFMPEG_PATH });
      return;
    }

    // List segments: GET /segments?agent=NAME&date=YYYY-MM-DD&pattern=OPTIONAL
    if (pathname === '/segments') {
      const agent = url.searchParams.get('agent');
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const pattern = url.searchParams.get('pattern');

      if (!agent) {
        sendJson(res, 400, { success: false, error: 'missing-agent-param' });
        return;
      }

      const result = await findSegments(agent, date, pattern);
      sendJson(res, result.success ? 200 : 404, result);
      return;
    }

    // Merge segments: GET /merge?agent=NAME&date=YYYY-MM-DD&pattern=OPTIONAL&delete=true
    if (pathname === '/merge') {
      const agent = url.searchParams.get('agent');
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const pattern = url.searchParams.get('pattern');
      const deleteAfter = url.searchParams.get('delete') === 'true';
      const cleanupInvalid = url.searchParams.get('cleanupInvalid') === 'true';

      if (!agent) {
        sendJson(res, 400, { success: false, error: 'missing-agent-param' });
        return;
      }

      const found = await findSegments(agent, date, pattern);
      if (!found.success || found.segments.length === 0) {
        sendJson(res, 404, { success: false, error: 'no-segments-found', folder: found.folder });
        return;
      }

      const { valid: validSegments, invalid: invalidSegments } = await filterValidSegments(found.segments);
      if (!validSegments.length) {
        if (cleanupInvalid && invalidSegments.length) {
          for (const seg of invalidSegments) {
            try { await fs.promises.unlink(seg.path); } catch (_) { }
          }
        }
        sendJson(res, 400, {
          success: false,
          error: 'no-valid-segments',
          invalidSegments: invalidSegments.map(s => s.name),
          cleanedInvalid: cleanupInvalid ? invalidSegments.length : 0
        });
        return;
      }

      const segmentPaths = validSegments.map(s => s.path);
      const outputName = `merged-${sanitizeSegment(agent)}-${date}-${Date.now()}.webm`;
      const outputPath = path.join(found.folder, outputName);

      const mergeResult = await mergeSegments(segmentPaths, outputPath);

      if (mergeResult.success && deleteAfter) {
        // Delete original segments after successful merge
        for (const segPath of segmentPaths) {
          try { await fs.promises.unlink(segPath); } catch (_) { }
        }
        console.log(`[recording-receiver] Deleted ${segmentPaths.length} segments after merge`);
      }

      if (cleanupInvalid && invalidSegments.length) {
        for (const seg of invalidSegments) {
          try { await fs.promises.unlink(seg.path); } catch (_) { }
        }
      }

      sendJson(res, mergeResult.success ? 200 : 500, {
        ...mergeResult,
        segmentNames: validSegments.map(s => s.name),
        invalidSegments: invalidSegments.map(s => s.name),
        cleanedInvalid: cleanupInvalid ? invalidSegments.length : 0,
        deletedSegments: deleteAfter && mergeResult.success
      });
      return;
    }

    // Merge ALL segments, auto-grouping by screen
    // GET /merge-all?agent=NAME&date=YYYY-MM-DD&delete=true
    // Creates separate merged files for each screen (screen0, screen1, etc.)
    if (pathname === '/merge-all') {
      const agent = url.searchParams.get('agent');
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const deleteAfter = url.searchParams.get('delete') === 'true';
      const cleanupInvalid = url.searchParams.get('cleanupInvalid') === 'true';

      if (!agent) {
        sendJson(res, 400, { success: false, error: 'missing-agent-param' });
        return;
      }

      const found = await findSegments(agent, date, null);
      if (!found.success || found.segments.length === 0) {
        sendJson(res, 404, { success: false, error: 'no-segments-found', folder: found.folder });
        return;
      }

      // Group segments by screen identifier
      const screenGroups = groupSegmentsByScreen(found.segments);
      const results = [];
      const allDeletedPaths = [];

      console.log(`[recording-receiver] Found ${screenGroups.size} screen group(s): ${[...screenGroups.keys()].join(', ')}`);

      for (const [screenId, segments] of screenGroups) {
        const { valid: validSegments, invalid: invalidSegments } = await filterValidSegments(segments);
        if (!validSegments.length) {
          if (cleanupInvalid && invalidSegments.length) {
            for (const seg of invalidSegments) {
              try { await fs.promises.unlink(seg.path); } catch (_) { }
            }
          }
          results.push({
            screenId,
            success: false,
            error: 'no-valid-segments',
            segmentCount: 0,
            segmentNames: [],
            invalidSegments: invalidSegments.map(s => s.name),
            cleanedInvalid: cleanupInvalid ? invalidSegments.length : 0
          });
          continue;
        }

        const segmentPaths = validSegments.map(s => s.path);
        const outputName = `merged-${sanitizeSegment(agent)}-${screenId}-${date}-${Date.now()}.webm`;
        const outputPath = path.join(found.folder, outputName);

        const mergeResult = await mergeSegments(segmentPaths, outputPath);

        results.push({
          screenId,
          ...mergeResult,
          segmentCount: validSegments.length,
          segmentNames: validSegments.map(s => s.name),
          invalidSegments: invalidSegments.map(s => s.name)
        });

        if (mergeResult.success && deleteAfter) {
          for (const segPath of segmentPaths) {
            try {
              await fs.promises.unlink(segPath);
              allDeletedPaths.push(segPath);
            } catch (_) { }
          }
        }

        if (cleanupInvalid && invalidSegments.length) {
          for (const seg of invalidSegments) {
            try { await fs.promises.unlink(seg.path); } catch (_) { }
          }
        }
      }

      if (deleteAfter && allDeletedPaths.length > 0) {
        console.log(`[recording-receiver] Deleted ${allDeletedPaths.length} segments after merge-all`);
      }

      const allSuccess = results.every(r => r.success);
      sendJson(res, allSuccess ? 200 : 207, {
        success: allSuccess,
        screenCount: screenGroups.size,
        results,
        deletedSegments: deleteAfter ? allDeletedPaths.length : 0
      });
      return;
    }

    // Repair segments: GET /repair-all?agent=NAME&date=YYYY-MM-DD&pattern=OPTIONAL&onlyInvalid=true
    // Writes repaired copies to a "repaired" subfolder without deleting originals
    if (pathname === '/repair-all') {
      const agent = url.searchParams.get('agent');
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const pattern = url.searchParams.get('pattern');
      const onlyInvalid = url.searchParams.get('onlyInvalid') !== 'false';

      if (!agent) {
        sendJson(res, 400, { success: false, error: 'missing-agent-param' });
        return;
      }

      const found = await findSegments(agent, date, pattern);
      if (!found.success || found.segments.length === 0) {
        sendJson(res, 404, { success: false, error: 'no-segments-found', folder: found.folder });
        return;
      }

      const { valid: validSegments, invalid: invalidSegments } = await filterValidSegments(found.segments);
      const targets = onlyInvalid ? invalidSegments : found.segments;

      if (!targets.length) {
        sendJson(res, 200, {
          success: true,
          repaired: 0,
          skipped: found.segments.length,
          invalidSegments: invalidSegments.map(s => s.name),
          folder: found.folder
        });
        return;
      }

      const outputFolder = path.join(found.folder, 'repaired');
      await fs.promises.mkdir(outputFolder, { recursive: true });

      const results = [];
      for (const seg of targets) {
        const parsed = path.parse(seg.name);
        const outputName = `${parsed.name}.fixed${parsed.ext || '.webm'}`;
        const outputPath = path.join(outputFolder, outputName);
        let result = await remuxWebmToOutput(seg.path, outputPath);
        let repairedBy = result.success ? 'ffmpeg-remux' : null;

        // Fallback for files with junk prefix bytes before EBML header.
        if (!result.success) {
          const headerOffset = await findEbmlHeaderOffset(seg.path, 4 * 1024 * 1024);
          if (headerOffset > 0) {
            console.warn(`[repair-all] ${seg.name}: remux failed, trimming ${headerOffset} leading bytes`);
            result = await trimWebmToOutput(seg.path, outputPath, headerOffset);
            if (result.success) repairedBy = 'ebml-header-trim';
          }
        }

        results.push({
          name: seg.name,
          outputName,
          success: result.success,
          repairedBy,
          error: result.error
        });
      }

      const repaired = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      sendJson(res, failed === 0 ? 200 : 207, {
        success: failed === 0,
        repaired,
        failed,
        results,
        invalidSegments: invalidSegments.map(s => s.name),
        outputFolder
      });
      return;
    }

    // Unknown GET path
    sendJson(res, 404, { error: 'not-found' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type'
    });
    res.end();
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
  const repairHeader = String(req.headers['x-ffmpeg-repair'] ?? 'true').toLowerCase();
  const shouldRepairWithFfmpeg = repairHeader !== 'false';
  const expectedSize = parseInt(req.headers['x-file-size'], 10);
  const expectedHash = req.headers['x-file-hash'];

  const { folder, targetPath } = buildTargetPath({ agentName, isoDate, fileName });

  try {
    await fs.promises.mkdir(folder, { recursive: true });

    // Read entire request body into buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);
    const receivedSize = fileBuffer.length;

    // Verify hash if provided
    if (expectedHash) {
      const actualHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
      if (actualHash !== expectedHash) {
        console.error(`[recording-receiver] Hash mismatch for ${fileName}. Expected ${expectedHash}, got ${actualHash}`);
        return sendJson(res, 400, {
          success: false,
          error: 'hash-mismatch',
          expectedHash,
          actualHash
        });
      }
    }

    // Verify size if provided
    if (!isNaN(expectedSize) && receivedSize !== expectedSize) {
      console.error(`[recording-receiver] Size mismatch for ${fileName}. Expected ${expectedSize}, got ${receivedSize}`);
      return sendJson(res, 400, {
        success: false,
        error: 'size-mismatch',
        expectedSize,
        receivedSize
      });
    }

    // Write file (overwrite if exists - this handles retries correctly)
    await fs.promises.writeFile(targetPath, fileBuffer);
    console.log(`[recording-receiver] Saved ${fileName} (${receivedSize} bytes) to ${targetPath}`);

    // Fix WebM duration metadata (runs async, doesn't block response)
    if (shouldRepairWithFfmpeg) {
      fixWebmDurationWithFfmpeg(targetPath).catch(err => {
        console.error(`[recording-receiver] FFmpeg fix failed for ${fileName}:`, err);
      });
    } else {
      console.log(`[recording-receiver] FFmpeg repair disabled for ${fileName}`);
    }

    sendJson(res, 200, {
      success: true,
      path: targetPath,
      size: receivedSize,
      verified: Boolean(expectedHash)
    });
  } catch (error) {
    console.error(`[recording-receiver] Error processing ${fileName}:`, error);
    sendJson(res, 500, { success: false, error: error?.message || 'write-failed' });
  }
});

// Configure server for extreme stability
// Disable timeouts to support large/slow uploads
server.timeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 0;

// Enable persistent connections
server.keepAlive = true;

server.listen(PORT, () => {
  console.log(`[recording-receiver] Listening on port ${PORT}`);
  console.log(`[recording-receiver] Saving to ${BASE_DIR}`);
  console.log(`[recording-receiver] Timeouts disabled (infinite)`);
});
