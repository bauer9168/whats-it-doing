const { json, originFromEvent, safeString, casePublicId, priceForQueue, supabaseRequest, requireEnv } = require('./_wid-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  try {
    const stripeKey = requireEnv('STRIPE_SECRET_KEY');
    const origin = originFromEvent(event);
    const body = JSON.parse(event.body || '{}');
    const price = priceForQueue(body.queue_type);
    const publicId = casePublicId();

    const consultPayload = {
      public_id: publicId,
      customer_name: safeString(body.customer_name, 160),
      customer_email: safeString(body.customer_email, 320).toLowerCase(),
      customer_phone: safeString(body.customer_phone, 60),
      phone_ok: !!body.phone_ok,
      vehicle_summary: safeString(body.vehicle_summary, 500),
      issue_summary: safeString(body.issue_summary, 700),
      work_done_summary: safeString(body.work_done_summary, 700),
      diy_status: safeString(body.diy_status, 60),
      ability_level: safeString(body.ability_level, 120),
      intake_text: safeString(body.intake_text, 6000),
      followup_text: safeString(body.followup_text, 6000),
      queue_type: safeString(body.queue_type || 'guided', 60),
      status: 'unpaid',
      payment_status: 'unpaid',
      stripe_checkout_session_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // This inserts the text case record first. File upload wiring can stay in the existing create-consult function
    // or be moved here once the final storage schema is fixed.
    const inserted = await supabaseRequest('consults', {
      method: 'POST',
      body: JSON.stringify(consultPayload)
    });
    const consult = Array.isArray(inserted) ? inserted[0] : inserted;
    const consultId = consult && (consult.id || consult.public_id || publicId);

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', `${origin}/customer-thread.html?session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', `${origin}/?payment=cancelled&case=${encodeURIComponent(String(consultId))}`);
    params.set('client_reference_id', String(consultId));
    params.set('customer_email', consultPayload.customer_email);
    params.set('metadata[consult_id]', String(consultId));
    params.set('metadata[public_id]', publicId);
    params.set('metadata[queue_type]', consultPayload.queue_type);
    params.set('line_items[0][quantity]', '1');
    params.set('line_items[0][price_data][currency]', 'usd');
    params.set('line_items[0][price_data][unit_amount]', String(price.amount));
    params.set('line_items[0][price_data][product_data][name]', price.label);
    params.set('line_items[0][price_data][product_data][description]', `${consultPayload.vehicle_summary || 'Vehicle consult'} — ${consultPayload.issue_summary || 'diagnostic review'}`.slice(0, 900));
    params.set('payment_intent_data[metadata][consult_id]', String(consultId));
    params.set('payment_intent_data[metadata][public_id]', publicId);

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const session = await stripeRes.json();
    if (!stripeRes.ok) throw new Error(session.error?.message || 'Stripe checkout session failed');

    try {
      await supabaseRequest(`consults?id=eq.${encodeURIComponent(String(consultId))}`, {
        method: 'PATCH',
        body: JSON.stringify({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() })
      });
    } catch (patchErr) {
      console.warn('Could not attach checkout session to consult; webhook/session metadata still contains consult_id.', patchErr);
    }

    return json(200, { ok: true, consult_id: consultId, public_id: publicId, checkout_url: session.url });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
