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

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });
    requireOperator(event);

    const qs = event.queryStringParameters || {};
    const requestedStatus = String(qs.status || 'all').toLowerCase();
    const limit = safeLimit(qs.limit);

    let path = `consults?select=*&order=updated_at.desc&limit=${limit}`;
    if (requestedStatus && requestedStatus !== 'all') {
      path = `consults?status=eq.${encodeURIComponent(requestedStatus)}&select=*&order=updated_at.desc&limit=${limit}`;
    }

    const consults = await supabaseRequest(path, { method: 'GET' });
    const rows = Array.isArray(consults) ? consults : [];

    let messages = [];
    try {
      messages = await supabaseRequest('consult_messages?select=*&order=created_at.asc', { method: 'GET' });
    } catch (_) {
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
      const lastText = last ? (last.text || last.body || (last.image_data || last.attachment_url ? 'Picture attached' : '')) : (c.last_message || '');
      return {
        ...c,
        messages: caseMessages,
        last_message: lastText,
        last_message_at: last ? (last.created_at || '') : (c.last_message_at || '')
      };
    });

    return json(200, { ok: true, consults: enriched });
  } catch (err) {
    console.error(err);
    return json(err.statusCode || 500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
