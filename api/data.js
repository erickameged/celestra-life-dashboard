// Vercel serverless function: fetches live data from SimpleFIN (both accounts)
// and returns it in the format the dashboard expects.

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
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

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

  const accounts = Object.values(allAcctMap);

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
  });
}
