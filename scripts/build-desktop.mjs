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

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCmd, ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: false
});

process.exit(result.status ?? 0);
