const crypto = require('crypto');
const { json, supabaseRequest, originFromEvent } = require('./_wid-shared');

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) throw new Error('Missing STRIPE_WEBHOOK_SECRET');
  const parts = String(sigHeader || '').split(',').reduce((acc, item) => {
    const [k, v] = item.split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const received = parts.v1 || '';
  if (!received || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) throw new Error('Bad Stripe signature');
}

async function sendLinkEmail({ to, name, threadUrl, publicId }) {
  if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL || !to) return { skipped: true };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to,
      subject: `What's it Doing? consult link${publicId ? ' — ' + publicId : ''}`,
      html: `<p>Payment received. Save this link for your consult thread:</p><p><a href="${threadUrl}">${threadUrl}</a></p><p>I’ll be in touch shortly.</p>`,
      text: `Payment received. Save this link for your consult thread:
${threadUrl}

I’ll be in touch shortly.`
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Email send failed');
  return data;
}

exports.handler = async (event) => {
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    verifyStripeSignature(rawBody, event.headers['stripe-signature'] || event.headers['Stripe-Signature'], process.env.STRIPE_WEBHOOK_SECRET);
    const stripeEvent = JSON.parse(rawBody);

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const consultId = session.metadata?.consult_id || session.client_reference_id;
      const publicId = session.metadata?.public_id || '';
      if (consultId) {
        await supabaseRequest(`consults?id=eq.${encodeURIComponent(String(consultId))}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'waiting_on_me',
            payment_status: session.payment_status || 'paid',
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: session.payment_intent || null,
            paid_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });
        try {
          await supabaseRequest('consult_messages', {
            method: 'POST',
            body: JSON.stringify({ consult_id: consultId, who: 'system', text: 'Payment received. Customer thread opened.', created_at: new Date().toISOString() })
          });
        } catch (_) {}
      }
      const origin = originFromEvent(event);
      const threadUrl = `${origin}/customer-thread.html?session_id=${encodeURIComponent(session.id)}`;
      const email = session.customer_details?.email || session.customer_email;
      await sendLinkEmail({ to: email, name: session.customer_details?.name, threadUrl, publicId });
    }

    return json(200, { received: true });
  } catch (err) {
    console.error(err);
    return json(400, { ok: false, error: err.message || String(err) });
  }
};
