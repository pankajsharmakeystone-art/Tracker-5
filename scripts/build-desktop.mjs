import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const envDesktopPath = path.join(repoRoot, '.env.desktop');

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    console.warn(`[build-desktop] Skipping missing env file: ${filePath}`);
    return;
  }
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    const value = line.slice(idx + 1).trim();
    process.env[key] = value;
  }
}

loadEnvFile(envDesktopPath);

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'cmd.exe' : 'npm';
const npmArgs = isWindows
  ? ['/c', 'npm', 'run', 'build:renderer:desktop']
  : ['run', 'build:renderer:desktop'];

console.log('[build-desktop] running npm run build:renderer:desktop');
const result = spawnSync(npmCmd, npmArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: false
});

if (result.error) {
  console.error('[build-desktop] failed to spawn npm:', result.error.message);
}

process.exit(result.status ?? 0);
