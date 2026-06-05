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
    const id = safeString(body.id, 120).trim();
    const status = safeString(body.status, 80).trim();
    if (!id) return json(400, { ok: false, error: 'Missing consult id' });
    if (!status) return json(400, { ok: false, error: 'Missing status' });

    const patch = { status, updated_at: new Date().toISOString() };
    if (status === 'closed') patch.closed_at = new Date().toISOString();
    if (status === 'waiting_on_me' || status === 'waiting_on_customer') patch.last_workflow_status = status;

    const updated = await supabaseRequest(`consults?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });

    return json(200, { ok: true, consult: Array.isArray(updated) ? updated[0] : updated });
  } catch (err) {
    console.error(err);
    return json(err.statusCode || 500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
