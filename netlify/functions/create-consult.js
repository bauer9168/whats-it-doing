exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BUCKET = process.env.SUPABASE_CONSULT_FILES_BUCKET || 'consult-files';

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Missing Supabase environment variables' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }

  const voiceNote = body.voice_note || null;
  const uploads = Array.isArray(body.uploads) ? body.uploads : [];

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
    const inserted = await supabaseRest('POST', '/rest/v1/consults', allowed, {
      Prefer: 'return=representation'
    });

    if (!inserted.ok) {
      return json(inserted.status, { ok: false, error: 'Supabase insert failed', details: inserted.data });
    }

    const consult = Array.isArray(inserted.data) ? inserted.data[0] : inserted.data;
    const consultId = consult && consult.id;
    if (!consultId) {
      return json(500, { ok: false, error: 'Supabase insert returned no consult id', details: inserted.data });
    }

    let voice_note_path = null;
    const upload_paths = [];
    const file_errors = [];

    if (voiceNote && voiceNote.dataUrl) {
      const uploaded = await uploadDataUrl(BUCKET, `${consultId}/voice-note-${Date.now()}.webm`, voiceNote);
      if (uploaded.ok) voice_note_path = uploaded.path;
      else file_errors.push({ kind: 'voice_note', status: uploaded.status, details: uploaded.data });
    }

    for (let i = 0; i < uploads.length; i++) {
      const item = uploads[i];
      if (!item || !item.dataUrl) continue;
      const safe = safeFileName(item.name || `upload-${i + 1}`);
      const uploaded = await uploadDataUrl(BUCKET, `${consultId}/${Date.now()}-${i + 1}-${safe}`, item);
      if (uploaded.ok) upload_paths.push({ path: uploaded.path, name: item.name || safe, type: item.type || 'application/octet-stream' });
      else file_errors.push({ kind: 'upload', file: item.name || '', status: uploaded.status, details: uploaded.data });
    }

    if (voice_note_path || upload_paths.length) {
      const patch = {};
      if (voice_note_path) patch.voice_note_path = voice_note_path;
      if (upload_paths.length) patch.upload_paths = upload_paths;

      const updated = await supabaseRest('PATCH', `/rest/v1/consults?id=eq.${encodeURIComponent(consultId)}`, patch, {
        Prefer: 'return=representation'
      });
      if (!updated.ok) {
        return json(200, { ok: true, consult, warning: 'Consult saved, file uploaded, but path update failed', details: updated.data, file_errors });
      }
      const finalConsult = Array.isArray(updated.data) ? updated.data[0] : updated.data;
      return json(200, { ok: true, consult: finalConsult || { ...consult, voice_note_path, upload_paths }, file_errors });
    }

    return json(200, { ok: true, consult, file_errors });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }

  async function uploadDataUrl(bucket, path, fileObj) {
    const parsed = parseDataUrl(fileObj.dataUrl);
    if (!parsed) return { ok: false, status: 400, data: { message: 'Invalid dataUrl' } };

    const endpoint = `/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}${endpoint}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': fileObj.type || parsed.mime || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: parsed.buffer
    });
    const data = await res.json().catch(async () => ({ text: await res.text().catch(() => '') }));
    return { ok: res.ok, status: res.status, data, path };
  }

  async function supabaseRest(method, path, payload, extraHeaders = {}) {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        ...extraHeaders
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }
};

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match || !match[2]) return null;
  const mime = match[1] || 'application/octet-stream';
  return { mime, buffer: Buffer.from(match[3] || '', 'base64') };
}

function safeFileName(name) {
  const cleaned = String(name || 'upload')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
  return cleaned || 'upload';
}

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
