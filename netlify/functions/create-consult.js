exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Missing Supabase environment variables' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const allowed = {
    customer_name: text(body.customer_name),
    phone_ok: Boolean(body.phone_ok),
    customer_phone: text(body.customer_phone),
    vehicle_summary: text(body.vehicle_summary),
    issue_summary: text(body.issue_summary),
    work_done_summary: text(body.work_done_summary),
    diy_status: text(body.diy_status),
    ability_level: text(body.ability_level),
    intake_text: text(body.intake_text),
    followup_text: text(body.followup_text),
    queue_type: text(body.queue_type || 'guided'),
    payment_status: text(body.payment_status || 'unpaid'),
    status: text(body.status || 'unpaid')
  };

  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/consults`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(allowed)
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      return json(res.status, { ok: false, error: 'Supabase insert failed', details: data });
    }

    return json(200, { ok: true, consult: Array.isArray(data) ? data[0] : data });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, 10000);
}

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(data)
  };
}
