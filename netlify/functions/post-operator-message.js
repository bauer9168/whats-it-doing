const { json, safeString, supabaseRequest } = require('./_wid-shared');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    requireOperator(event);
    const body = JSON.parse(event.body || '{}');
    const id = safeString(body.id || body.consult_id, 120).trim();
    const text = safeString(body.text, 6000).trim();
    if (!id) return json(400, { ok: false, error: 'Missing consult id' });
    if (!text) return json(400, { ok: false, error: 'Message is empty' });

    const inserted = await supabaseRequest('consult_messages', {
      method: 'POST',
      body: JSON.stringify({ consult_id: id, who: 'operator', text, created_at: new Date().toISOString() })
    });

    try {
      await supabaseRequest(`consults?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'waiting_on_customer', updated_at: new Date().toISOString() })
      });
    } catch (_) {}

    return json(200, { ok: true, message: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (err) {
    console.error(err);
    return json(err.statusCode || 500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
