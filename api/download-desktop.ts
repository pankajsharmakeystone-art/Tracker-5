import type { VercelRequest, VercelResponse } from '@vercel/node';

const OWNER = 'pankajsharmakeystone-art';
const REPO = 'Tracker-5';
const DEFAULT_ASSET = 'Tracker-5-Desktop-Setup.exe';

function buildHeaders() {
  const token = process.env.GITHUB_DOWNLOAD_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'tracker-5-downloader'
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return headers;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const releaseResponse = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: buildHeaders()
    });

    if (!releaseResponse.ok) {
      const message = `Failed to fetch latest release (${releaseResponse.status})`;
      res.status(502).json({ error: message });
      return;
    }

    const release = await releaseResponse.json();
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((a: any) => a?.name === DEFAULT_ASSET)
      || assets.find((a: any) => typeof a?.name === 'string' && a.name.endsWith('.exe'));

    if (!asset?.browser_download_url) {
      res.status(404).json({ error: 'Desktop installer not found in latest release' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, asset.browser_download_url);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message || 'Unexpected error while downloading desktop app' });
  }
}
