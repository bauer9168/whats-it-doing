const { json, requireEnv, safeString, supabaseRequest } = require('./_wid-shared');

async function retrieveSession(sessionId) {
  const stripeKey = requireEnv('STRIPE_SECRET_KEY');
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${stripeKey}` }
  });
  const session = await res.json();
  if (!res.ok) throw new Error(session.error?.message || 'Could not verify checkout session');
  return session;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const sessionId = body.session_id || '';
    const text = safeString(body.text, 6000).trim();
    if (!sessionId) return json(400, { ok: false, error: 'Missing session_id' });
    if (!text) return json(400, { ok: false, error: 'Message is empty' });
    const session = await retrieveSession(sessionId);
    if (session.payment_status !== 'paid') return json(402, { ok: false, error: 'Payment not complete yet' });
    const consultId = session.metadata?.consult_id || session.client_reference_id;
    if (!consultId) return json(404, { ok: false, error: 'No consult linked to this payment' });

    const row = {
      consult_id: consultId,
      who: 'customer',
      text,
      created_at: new Date().toISOString()
    };
    let inserted;
    try {
      inserted = await supabaseRequest('consult_messages', { method: 'POST', body: JSON.stringify(row) });
      await supabaseRequest(`consults?id=eq.${encodeURIComponent(String(consultId))}`, { method: 'PATCH', body: JSON.stringify({ status: 'waiting_on_me', updated_at: new Date().toISOString() }) });
    } catch (err) {
      err.message = 'Message table is not ready yet. Run the included Supabase SQL schema, then retry. ' + err.message;
      throw err;
    }
    return json(200, { ok: true, message: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
