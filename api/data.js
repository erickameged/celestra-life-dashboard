// Vercel serverless function: fetches live data from SimpleFIN (both accounts)
// and returns it in the format the dashboard expects.
// Accepts ?token=<user_token> to return a user-restricted view.

const REPO = 'erickameged/celestra-life-dashboard';

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

function buildGhProxyUrl(targetUrl, pdProjectId) {
  const b64 = Buffer.from(targetUrl, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const qs = new URLSearchParams({
    account_id: process.env.GH_ACCOUNT_ID,
    external_user_id: process.env.GH_EXTERNAL_USER_ID,
  });
  return `https://api.pipedream.com/v1/connect/${pdProjectId}/proxy/${b64}?${qs}`;
}

let _usersCache = null;
let _usersCacheTs = 0;

async function getUsersFromGitHub() {
  const now = Date.now();
  if (_usersCache && now - _usersCacheTs < 60_000) return _usersCache;
  try {
    const pdToken = await getPdToken();
    const pdProjectId = process.env.PD_PROJECT_ID;
    const res = await fetch(buildGhProxyUrl(`https://api.github.com/repos/${REPO}/contents/users.json`, pdProjectId), {
      headers: { 'Authorization': `Bearer ${pdToken}`, 'x-pd-environment': 'production' },
    });
    if (!res.ok) return [];
    const j = await res.json();
    _usersCache = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    _usersCacheTs = now;
    return Array.isArray(_usersCache) ? _usersCache : [];
  } catch { return []; }
}

const CATEGORY_MAP = [
  [/transfer|zelle|ach|wire/i, 'Transfers Out'],
  [/amazon|amzn/i, 'Online Shopping'],
  [/whole foods|grocery|market|food/i, 'Groceries'],
  [/restaurant|café|cafe|dining|pizza|doordash|grubhub|uber eats/i, 'Dining'],
  [/delta|united|american air|southwest|flight|airline|hotel|marriott|hilton|hyatt|airbnb/i, 'Travel'],
  [/chase credit|amex|capital one|citi.*pay|autopay/i, 'Credit Card Payments'],
  [/insurance|geico|allstate|progressive/i, 'Insurance'],
  [/dental|medical|pharmacy|cvs|walgreens|health/i, 'Healthcare'],
  [/gas|shell|chevron|bp|exxon|fuel/i, 'Gas & Fuel'],
  [/fee|interest|annual/i, 'Bank Fees & Interest'],
  [/payroll|salary|direct dep|adp|paychex/i, 'Payroll & Income'],
  [/rent|mortgage|lease/i, 'Rent & Mortgage'],
  [/office|staples|best buy|apple|microsoft|software|subscription|saas/i, 'Office & Technology'],
  [/gatewayfees|certificate of origin/i, 'Business Income'],
  [/torsion|consulting|professional/i, 'Professional Services'],
  [/integrityconnect|bounteous/i, 'Marketing & Advertising'],
  [/etrade|schwab|fidelity|vanguard|robinhood|td ameritrade/i, 'Investment'],
];

function inferCategory(payee, description, amount) {
  const text = ((payee || '') + ' ' + (description || '')).toLowerCase();
  for (const [pattern, cat] of CATEGORY_MAP) {
    if (pattern.test(text)) return cat;
  }
  return amount > 0 ? 'Other Income' : 'Uncategorized/Other';
}

function toDateStr(unixTs) {
  const d = new Date(unixTs * 1000);
  return d.toISOString().split('T')[0];
}

async function fetchSimpleFIN(accessUrl, startDateTs) {
  const u = new URL(accessUrl);
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  const endpoint = u.toString().replace(/\/$/, '') + '/accounts?start-date=' + startDateTs;
  const headers = { 'Accept': 'application/json' };
  if (username) {
    headers['Authorization'] = 'Basic ' + Buffer.from(username + ':' + (password || '')).toString('base64');
  }
  const res = await fetch(endpoint, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('SimpleFIN ' + res.status + ': ' + text.slice(0, 200));
  }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // Resolve user view restriction if ?token= provided
  let allowedAccounts = null; // null = no restriction (admin)
  let viewUser = null;
  const userToken = req.query.token;
  if (userToken) {
    const users = await getUsersFromGitHub();
    const matchedUser = users.find(u => u.token === userToken);
    if (!matchedUser) return res.status(403).json({ error: 'Invalid or expired access token' });
    allowedAccounts = matchedUser.allowed_accounts || [];
    viewUser = { id: matchedUser.id, name: matchedUser.name };
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  }

  const startDateParam = req.query.start_date;
  let startTs;
  if (startDateParam && /^\d{4}-\d{2}-\d{2}$/.test(startDateParam)) {
    startTs = Math.floor(new Date(startDateParam + 'T00:00:00Z').getTime() / 1000);
  } else {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    startTs = Math.floor(d.getTime() / 1000);
  }

  const accessUrls = [
    process.env.SFIN_URL_1,
    process.env.SFIN_URL_2,
  ].filter(Boolean);

  if (accessUrls.length === 0) {
    res.status(500).json({ error: 'No SimpleFIN credentials configured (SFIN_URL_1 / SFIN_URL_2)' });
    return;
  }

  const allAcctMap = {};
  const errors = [];

  for (const url of accessUrls) {
    try {
      const data = await fetchSimpleFIN(url, startTs);
      for (const acct of data.accounts || []) {
        // Deduplicate by account ID; last write wins (same data from both accounts)
        allAcctMap[acct.id] = acct;
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  let accounts = Object.values(allAcctMap);

  // Filter accounts for user view
  if (allowedAccounts !== null) {
    accounts = accounts.filter(a => allowedAccounts.includes(a.name));
  }

  // Build LIVE_BALANCES shape
  const liveBalances = {};
  for (const acct of accounts) {
    liveBalances[acct.name] = {
      balance: parseFloat(acct.balance) || 0,
      institution: acct.org?.name || 'Unknown',
      isNew: false,
    };
  }

  // Build transaction rows
  const seenTxIds = new Set();
  const rows = [];
  for (const acct of accounts) {
    for (const tx of acct.transactions || []) {
      if (seenTxIds.has(tx.id)) continue;
      seenTxIds.add(tx.id);
      const dateStr = toDateStr(tx.posted || tx.transacted_at);
      const monthStr = dateStr.slice(0, 7);
      const amount = parseFloat(tx.amount) || 0;
      rows.push({
        date: dateStr,
        month: monthStr,
        account: acct.name,
        description: tx.description || '',
        payee: tx.payee || '',
        amount,
        type: amount < 0 ? 'Expense' : 'Income',
        category: inferCategory(tx.payee, tx.description, amount),
      });
    }
  }

  rows.sort((a, b) => b.date.localeCompare(a.date));

  res.json({
    rows,
    accounts: liveBalances,
    generatedAt: new Date().toISOString(),
    errors: errors.length ? errors : undefined,
    viewUser: viewUser || undefined,
  });
}
