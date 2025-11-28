import { Readable } from 'node:stream';

const OWNER = 'pankajsharmakeystone-art';
const REPO = 'Tracker-5';
const DEFAULT_ASSET = 'Tracker-5-Desktop-Setup.exe';

function buildHeaders(extra = {}) {
  const token = process.env.GITHUB_DOWNLOAD_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = {
    'User-Agent': 'tracker-5-downloader',
    ...extra,
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return headers;
}

export default async function handler(_req, res) {
  try {
    const releaseResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: buildHeaders(),
    });

    if (!releaseResponse.ok) {
      const message = `Failed to fetch latest release (${releaseResponse.status})`;
      res.status(502).json({ error: message });
      return;
    }

    const release = await releaseResponse.json();
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((a) => a?.name === DEFAULT_ASSET)
      || assets.find((a) => typeof a?.name === 'string' && a.name.endsWith('.exe'));

    if (!asset?.url) {
      res.status(404).json({ error: 'Desktop installer not found in latest release' });
      return;
    }

    const filename = asset?.name || DEFAULT_ASSET;
    const downloadResponse = await fetch(asset.url, {
      headers: buildHeaders({ Accept: 'application/octet-stream' }),
    });

    if (!downloadResponse.ok || !downloadResponse.body) {
      const message = `Failed to fetch asset binary (${downloadResponse.status})`;
      res.status(502).json({ error: message });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const nodeStream = Readable.fromWeb(downloadResponse.body);
    nodeStream.pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unexpected error while downloading desktop app' });
  }
}
