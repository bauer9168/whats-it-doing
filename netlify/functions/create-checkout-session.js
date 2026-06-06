const { json, originFromEvent, safeString, casePublicId, priceForQueue, supabaseRequest, requireEnv } = require('./_wid-shared');

function safeFileName(name, fallback = 'upload') {
  const base = String(name || fallback).split(/[\\/]/).pop() || fallback;
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || fallback;
}

function parseDataUrl(dataUrl) {
  const value = String(dataUrl || '');
  const match = value.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const contentType = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const raw = match[3] || '';
  const buffer = isBase64 ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8');
  return { contentType, buffer };
}

function publicStorageUrl(bucket, path) {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function uploadStorageObject(bucket, path, contentType, buffer) {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'false'
    },
    body: buffer
  });
  const text = await response.text();
  let details = text;
  try { details = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    const err = new Error(`Supabase storage ${response.status}`);
    err.details = details;
    throw err;
  }
  return { path, url: publicStorageUrl(bucket, path) };
}

async function saveUploads({ publicId, uploads = [], voiceNote = null }) {
  const bucket = process.env.SUPABASE_UPLOAD_BUCKET || 'consult-uploads';
  const fileLinks = [];
  let voice = { path: '', url: '' };
  const basePath = safeFileName(publicId || casePublicId(), 'case');

  const limitedUploads = Array.isArray(uploads) ? uploads.slice(0, 8) : [];
  let i = 0;
  for (const item of limitedUploads) {
    i += 1;
    const parsed = parseDataUrl(item && item.dataUrl);
    if (!parsed || !parsed.buffer.length) continue;
    if (parsed.buffer.length > 8 * 1024 * 1024) throw new Error('One upload is too large after resizing. Please use a smaller photo/file.');
    const name = safeFileName((item && (item.name || item.original_name)) || `upload-${i}`);
    const path = `${basePath}/${Date.now()}-${i}-${name}`;
    const saved = await uploadStorageObject(bucket, path, item.type || parsed.contentType, parsed.buffer);
    fileLinks.push({
      name,
      path: saved.path,
      url: saved.url,
      type: item.type || parsed.contentType,
      size: item.size || parsed.buffer.length
    });
  }

  if (voiceNote && voiceNote.dataUrl) {
    const parsed = parseDataUrl(voiceNote.dataUrl);
    if (parsed && parsed.buffer.length) {
      if (parsed.buffer.length > 12 * 1024 * 1024) throw new Error('Voice note is too large. Please keep it shorter.');
      const name = safeFileName(voiceNote.name || 'voice-note.webm');
      const path = `${basePath}/${Date.now()}-voice-${name}`;
      voice = await uploadStorageObject(bucket, path, voiceNote.type || parsed.contentType || 'audio/webm', parsed.buffer);
    }
  }

  return { fileLinks, voicePath: voice.path, voiceUrl: voice.url };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || '';
    if (!stripeKey) {
      const err = new Error('Missing environment variable: STRIPE_SECRET_KEY. Netlify Functions cannot see it yet. Confirm the variable is scoped to Functions/Runtime and trigger a fresh deploy.');
      err.statusCode = 500;
      throw err;
    }
    const origin = originFromEvent(event);
    const body = JSON.parse(event.body || '{}');
    const price = priceForQueue(body.queue_type);
    const publicId = casePublicId();

    const saved = await saveUploads({ publicId, uploads: body.uploads, voiceNote: body.voice_note });

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
      file_links: saved.fileLinks,
      voice_note_path: saved.voicePath || null,
      voice_note_url: saved.voiceUrl || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    let inserted;
    try {
      inserted = await supabaseRequest('consults', {
        method: 'POST',
        body: JSON.stringify(consultPayload)
      });
    } catch (insertErr) {
      const details = JSON.stringify(insertErr.details || '').toLowerCase();
      if (!/updated_at|created_at|file_links|voice_note|column|schema/.test(details)) throw insertErr;
      const fallbackPayload = { ...consultPayload };
      delete fallbackPayload.updated_at;
      delete fallbackPayload.created_at;
      // If an older consults table is still deployed, do one fallback insert with older optional columns removed.
      if (/file_links/.test(details)) delete fallbackPayload.file_links;
      if (/voice_note/.test(details)) { delete fallbackPayload.voice_note_path; delete fallbackPayload.voice_note_url; }
      inserted = await supabaseRequest('consults', {
        method: 'POST',
        body: JSON.stringify(fallbackPayload)
      });
    }
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

    return json(200, { ok: true, consult_id: consultId, public_id: publicId, checkout_url: session.url, file_links: saved.fileLinks, voice_note_url: saved.voiceUrl });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
