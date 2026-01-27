#!/usr/bin/env node
/*
  Repair WebM files by remuxing with FFmpeg.
  - Keeps originals
  - Writes fixed files to output folder

  Usage:
    node scripts/repair-webm.js --input "C:\path\to\folder" --output "C:\path\to\out" --pattern ".webm" --overwrite

  Notes:
  - Uses ffmpeg-static if available, otherwise system ffmpeg.
*/

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function findFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch (_) {
    // ignore
  }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function parseArgs(argv) {
  const args = { input: '', output: '', pattern: '.webm', overwrite: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--input') { args.input = val || ''; i++; }
    else if (key === '--output') { args.output = val || ''; i++; }
    else if (key === '--pattern') { args.pattern = val || '.webm'; i++; }
    else if (key === '--overwrite') { args.overwrite = true; }
    else if (key === '--dry-run') { args.dryRun = true; }
  }
  return args;
}

function listFiles(dir, pattern) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(pattern.toLowerCase())) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

function remuxFile(ffmpegPath, inputPath, outputPath) {
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

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, error: null });
      } else {
        resolve({ success: false, error: stderr.slice(-800) || `ffmpeg exit code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err?.message || 'ffmpeg spawn error' });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Missing --input');
    process.exitCode = 1;
    return;
  }

  const inputDir = path.resolve(args.input);
  const outputDir = path.resolve(args.output || path.join(inputDir, 'repaired'));
  const ffmpegPath = findFfmpegPath();

  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error('Input path is not a directory:', inputDir);
    process.exitCode = 1;
    return;
  }

  if (!args.dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const files = listFiles(inputDir, args.pattern);
  if (files.length === 0) {
    console.log('No files found:', inputDir);
    return;
  }

  console.log(`FFmpeg: ${ffmpegPath}`);
  console.log(`Found ${files.length} file(s). Output: ${outputDir}`);

  let repaired = 0;
  let failed = 0;

  for (const filePath of files) {
    const base = path.basename(filePath);
    const outPath = path.join(outputDir, base.replace(/\.webm$/i, '.fixed.webm'));

    if (!args.overwrite && fs.existsSync(outPath)) {
      console.log(`[skip] ${base} -> output exists`);
      continue;
    }

    if (args.dryRun) {
      console.log(`[dry-run] ${base} -> ${path.basename(outPath)}`);
      continue;
    }

    const result = await remuxFile(ffmpegPath, filePath, outPath);
    if (result.success) {
      repaired++;
      console.log(`[ok] ${base} -> ${path.basename(outPath)}`);
    } else {
      failed++;
      console.log(`[fail] ${base}: ${result.error}`);
    }
  }

  console.log(`Done. repaired=${repaired}, failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
