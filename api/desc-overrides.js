// api/desc-overrides.js — read/write description overrides stored in Google Sheets
const SHEET_ID = process.env.DESC_SHEET_ID;

async function getPdToken() {
  const res = await fetch('https://api.pipedream.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.PD_CLIENT_ID,
      client_secret: process.env.PD_CLIENT_SECRET,
    }),
  });
  return (await res.json()).access_token;
}

function buildGsProxyUrl(targetUrl) {
  const b64 = Buffer.from(targetUrl, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const qs = new URLSearchParams({
    account_id: process.env.GS_ACCOUNT_ID,
    external_user_id: process.env.GH_EXTERNAL_USER_ID,
  });
  return `https://api.pipedream.com/v1/connect/${process.env.PD_PROJECT_ID}/proxy/${b64}?${qs}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const pdToken = await getPdToken();
    const authHeaders = {
      'Authorization': `Bearer ${pdToken}`,
      'x-pd-environment': 'production',
    };

    if (req.method === 'GET') {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Overrides!A:D`;
      const r = await fetch(buildGsProxyUrl(url), { headers: authHeaders });
      const data = await r.json();
      // Skip header row, take LAST entry per txn_key (append-only log)
      const rows = (data.values || []).slice(1);
      const map = {};
      for (const row of rows) {
        if (row[0]) map[row[0]] = row[1] || '';
      }
      // Filter out reverted (empty) entries
      const result = {};
      for (const k in map) { if (map[k]) result[k] = map[k]; }
      return res.json(result);
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const { txn_key, custom_desc, updated_by } = body || {};
      if (!txn_key) return res.status(400).json({ error: 'txn_key required' });

      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Overrides!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
      const r = await fetch(buildGsProxyUrl(url), {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
          'x-pd-proxy-content-type': 'application/json',
        },
        body: JSON.stringify({
          values: [[txn_key, custom_desc || '', new Date().toISOString(), updated_by || 'user']],
        }),
      });
      const data = await r.json();
      return res.json({ ok: true, detail: data });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
