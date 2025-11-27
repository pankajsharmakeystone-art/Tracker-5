const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const envDesktopPath = path.join(repoRoot, '.env.desktop');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[build-desktop] Skipping missing env file: ${filePath}`);
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    if (!line || /^\s*#/.test(line)) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    if (!key) return;
    const value = line.slice(idx + 1).trim();
    process.env[key] = value;
  });
}

loadEnvFile(envDesktopPath);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCmd, ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}
