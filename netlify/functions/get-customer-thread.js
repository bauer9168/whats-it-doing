const { json, requireEnv, supabaseRequest } = require('./_wid-shared');

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
  try {
    const sessionId = event.queryStringParameters?.session_id || '';
    if (!sessionId) return json(400, { ok: false, error: 'Missing session_id' });
    const session = await retrieveSession(sessionId);
    if (session.payment_status !== 'paid') return json(402, { ok: false, error: 'Payment not complete yet' });
    const consultId = session.metadata?.consult_id || session.client_reference_id;
    if (!consultId) return json(404, { ok: false, error: 'No consult linked to this payment' });

    const consultRows = await supabaseRequest(`consults?id=eq.${encodeURIComponent(String(consultId))}&select=*`, { method: 'GET' });
    const consult = Array.isArray(consultRows) ? consultRows[0] : consultRows;
    if (!consult) return json(404, { ok: false, error: 'Consult not found' });

    let messages = [];
    try {
      messages = await supabaseRequest(`consult_messages?consult_id=eq.${encodeURIComponent(String(consultId))}&select=*&order=created_at.asc`, { method: 'GET' });
    } catch (msgErr) {
      messages = [{ who: 'system', text: 'Payment received. Your consult thread is open.', created_at: '' }];
    }
    return json(200, { ok: true, consult, messages });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
