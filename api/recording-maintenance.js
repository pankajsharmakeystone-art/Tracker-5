const parseJsonBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null;
    }
  }
  return null;
};

const normalizeUploadBase = (uploadUrl) => {
  const parsed = new URL(uploadUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('invalid_protocol');
  }
  parsed.pathname = parsed.pathname.replace(/\/upload\/?$/i, '') || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  try {
    const body = await parseJsonBody(req);
    const action = String(body?.action || '').trim().toLowerCase();
    const uploadUrl = String(body?.uploadUrl || '').trim();
    const agent = String(body?.agent || '').trim();
    const date = String(body?.date || '').trim();
    const token = String(body?.token || '').trim();

    if (!uploadUrl) return res.status(400).json({ error: 'missing_upload_url' });
    if (!agent) return res.status(400).json({ error: 'missing_agent' });
    if (!date) return res.status(400).json({ error: 'missing_date' });
    if (action !== 'merge' && action !== 'repair') return res.status(400).json({ error: 'invalid_action' });

    const baseUrl = normalizeUploadBase(uploadUrl);
    const endpoint = action === 'merge' ? '/merge-all' : '/repair-all';
    const targetUrl = new URL(endpoint, baseUrl);
    targetUrl.searchParams.set('agent', agent);
    targetUrl.searchParams.set('date', date);
    if (action === 'merge') {
      targetUrl.searchParams.set('delete', 'true');
    } else {
      targetUrl.searchParams.set('onlyInvalid', 'false');
    }

    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const upstream = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers
    });

    const rawText = await upstream.text().catch(() => '');
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        data = { message: rawText };
      }
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'upstream_error',
        status: upstream.status,
        details: data
      });
    }

    return res.status(200).json({
      success: true,
      action,
      target: targetUrl.toString(),
      result: data
    });
  } catch (error) {
    return res.status(500).json({
      error: 'proxy_failed',
      message: error?.message || String(error)
    });
  }
}

