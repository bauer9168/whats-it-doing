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

// Columns verified against the current consults export. Do not add year/make/model here;
// those are not current consults columns and will cause a Supabase/PostgREST 400.
// This stays lightweight by not selecting consult_messages or inline image_data.
const LIST_FIELDS = [
  'id',
  'created_at',
  'updated_at',
  'customer_name',
  'phone_ok',
  'customer_phone',
  'customer_email',
  'vehicle_summary',
  'issue_summary',
  'work_done_summary',
  'intake_text',
  'followup_text',
  'diy_status',
  'ability_level',
  'queue_type',
  'payment_status',
  'status',
  'stripe_session_id',
  'stripe_checkout_session_id',
  'stripe_payment_intent_id',
  'voice_note_path',
  'upload_paths',
  'public_id',
  'paid_at',
  'closed_at',
  'file_links',
  'voice_note_url',
  'last_workflow_status',
  'last_message',
  'last_message_at',
  'upload_count',
  'has_voice_note'
].join(',');

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function isClosedOrArchived(c) {
  const status = normalized(c.status);
  return status === 'closed' || status === 'archived';
}

function isPaidOrManual(c) {
  const paymentStatus = normalized(c.payment_status);
  return (
    paymentStatus === 'paid' ||
    paymentStatus === 'manual' ||
    paymentStatus === 'comped' ||
    paymentStatus === 'no_charge' ||
    paymentStatus === 'waived' ||
    !!c.paid_at ||
    !!c.stripe_payment_intent_id ||
    !!c.public_id
  );
}

function shouldShowInOperator(c) {
  // Keep unpaid/abandoned intake rows saved in Supabase, but keep them out of
  // active operator queues even if a local/status action accidentally moved them
  // to waiting_on_customer or waiting_on_me.
  // Closed/archived rows are still allowed through so the archive view remains usable.
  if (isClosedOrArchived(c)) return true;
  return isPaidOrManual(c);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== 'GET') {
      return json(405, { ok: false, error: 'Method not allowed' });
    }

    requireOperator(event);

    const qs = event.queryStringParameters || {};
    const requestedStatus = normalized(qs.status || 'all');
    const limit = safeLimit(qs.limit);

    const params = new URLSearchParams();
    params.set('select', LIST_FIELDS);
    params.set('order', 'updated_at.desc');
    params.set('limit', String(limit));

    if (requestedStatus && requestedStatus !== 'all') {
      params.set('status', `eq.${requestedStatus}`);
    }

    const consults = await supabaseRequest(`consults?${params.toString()}`, {
      method: 'GET'
    });

    const rows = Array.isArray(consults) ? consults : [];
    const operatorRows = rows.filter(shouldShowInOperator);

    const lightweightRows = operatorRows.map((c) => ({
      id: c.id,
      created_at: c.created_at || null,
      updated_at: c.updated_at || null,
      customer_name: c.customer_name || '',
      phone_ok: !!c.phone_ok,
      customer_phone: c.customer_phone || '',
      customer_email: c.customer_email || '',
      vehicle_summary: c.vehicle_summary || 'Vehicle not clear yet',
      issue_summary: c.issue_summary || 'Issue path still needs review',
      work_done_summary: c.work_done_summary || '',
      intake_text: c.intake_text || '',
      followup_text: c.followup_text || '',
      diy_status: c.diy_status || '',
      ability_level: c.ability_level || '',
      queue_type: c.queue_type || '',
      payment_status: c.payment_status || '',
      status: c.status || '',
      stripe_session_id: c.stripe_session_id || '',
      stripe_checkout_session_id: c.stripe_checkout_session_id || '',
      stripe_payment_intent_id: c.stripe_payment_intent_id || '',
      voice_note_path: c.voice_note_path || '',
      upload_paths: Array.isArray(c.upload_paths) ? c.upload_paths : [],
      public_id: c.public_id || null,
      paid_at: c.paid_at || null,
      closed_at: c.closed_at || null,
      file_links: Array.isArray(c.file_links) ? c.file_links : [],
      voice_note_url: c.voice_note_url || null,
      last_workflow_status: c.last_workflow_status || null,
      last_message: c.last_message || '',
      last_message_at: c.last_message_at || c.updated_at || c.created_at || '',
      upload_count: Number(c.upload_count || 0),
      has_voice_note: !!c.has_voice_note
    }));

    return json(200, {
      ok: true,
      consults: lightweightRows
    });
  } catch (err) {
    console.error(err);
    return json(err.statusCode || 500, {
      ok: false,
      error: err.message || String(err),
      details: err.details || undefined
    });
  }
};
