const fs = require('fs');
const path = require('path');

const rootPackagePath = path.resolve(__dirname, '..', 'package.json');
const electronPackagePath = path.resolve(__dirname, '..', 'electron', 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

(function syncVersion() {
  const rootPkg = readJson(rootPackagePath);
  const electronPkg = readJson(electronPackagePath);
  const version = rootPkg.version;

  if (!version) {
    throw new Error('Root package.json is missing a version field.');
  }

  if (electronPkg.version === version) {
    console.log('electron/package.json already at version', version);
    return;
  }

  electronPkg.version = version;
  writeJson(electronPackagePath, electronPkg);
  console.log('Updated electron/package.json to version', version);
})();
