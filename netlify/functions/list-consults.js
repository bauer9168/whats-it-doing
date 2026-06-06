const { json, supabaseRequest } = require('./_wid-shared');

function requireOperator(event) {
  const expected = process.env.OPERATOR_PIN || '';
  if (!expected) return;
  const headers = event.headers || {};
  const got = headers['x-operator-pin'] || headers['X-Operator-Pin'] || '';
  if (String(got) !== String(expected)) {
    const err = new Error('Bad operator PIN');
    err.statusCode = 401;
    throw err;
  }
}

function safeLimit(value) {
  const n = Number(value || 100);
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(250, Math.floor(n)));
}

async function getConsultRows(requestedStatus, limit) {
  const base = requestedStatus && requestedStatus !== 'all'
    ? `consults?status=eq.${encodeURIComponent(requestedStatus)}&select=*&limit=${limit}`
    : `consults?select=*&limit=${limit}`;

  const attempts = [
    base + '&order=updated_at.desc',
    base + '&order=created_at.desc',
    base
  ];

  let lastErr = null;
  for (const path of attempts) {
    try {
      const data = await supabaseRequest(path, { method: 'GET' });
      return Array.isArray(data) ? data : [];
    } catch (err) {
      lastErr = err;
      // Some existing Supabase tables from the earlier app do not have updated_at yet.
      // Fall back instead of making the operator page unusable.
      const details = JSON.stringify(err.details || '').toLowerCase();
      if (!/updated_at|created_at|order|column|schema|400/.test(details + ' ' + String(err.message || '').toLowerCase())) break;
    }
  }
  throw lastErr || new Error('Could not load consults');
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
    requireOperator(event);

    const qs = event.queryStringParameters || {};
    const requestedStatus = String(qs.status || 'all').toLowerCase();
    const limit = safeLimit(qs.limit);

    const rows = await getConsultRows(requestedStatus, limit);

    let messages = [];
    try {
      messages = await supabaseRequest('consult_messages?select=*&order=created_at.asc', { method: 'GET' });
    } catch (err) {
      // The operator queue should still load even if the new thread table has not been created yet.
      console.warn('consult_messages unavailable; returning consult list without message history', err.message || err);
      messages = [];
    }

    const grouped = new Map();
    for (const m of Array.isArray(messages) ? messages : []) {
      const key = String(m.consult_id || '');
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(m);
    }

    const enriched = rows.map(c => {
      const caseMessages = grouped.get(String(c.id || '')) || [];
      const last = caseMessages.length ? caseMessages[caseMessages.length - 1] : null;
      return {
        ...c,
        messages: caseMessages,
        last_message: last ? (last.text || '') : (c.last_message || ''),
        last_message_at: last ? (last.created_at || '') : (c.last_message_at || '')
      };
    });

    return json(200, { ok: true, consults: enriched });
  } catch (err) {
    console.error(err);
    return json(err.statusCode || 500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
