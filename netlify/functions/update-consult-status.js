const { json, safeString, supabaseRequest, originFromEvent } = require('./_wid-shared');



function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function shortLine(s, max = 280) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function sendClosedEmail(event, consultId) {
  if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) return { skipped: true };
  const consults = await supabaseRequest(`consults?id=eq.${encodeURIComponent(consultId)}&select=*`, { method: 'GET' });
  const c = Array.isArray(consults) ? consults[0] : null;
  if (!c || !c.customer_email) return { skipped: true };
  const messages = await supabaseRequest(`consult_messages?consult_id=eq.${encodeURIComponent(consultId)}&select=who,text,created_at,image_name,attachment_name&order=created_at.asc`, { method: 'GET' });
  const origin = originFromEvent(event);
  const session = c.stripe_checkout_session_id || '';
  const threadUrl = session ? `${origin}/customer-thread.html?session_id=${encodeURIComponent(session)}` : origin;
  const vehicle = shortLine(c.vehicle_summary || [c.vehicle_year, c.vehicle_make, c.vehicle_model, c.vehicle_mileage || c.mileage].filter(Boolean).join(' '), 120);
  const issue = shortLine(c.issue_summary || c.symptom_summary || c.summary || c.intake_text, 160);
  const lines = (Array.isArray(messages) ? messages : []).map(m => {
    const who = String(m.who || '').toLowerCase().includes('operator') ? 'Bryan' : String(m.who || '').toLowerCase().includes('system') ? 'System' : 'Customer';
    const text = shortLine(m.text || '', 500);
    const attach = [m.image_name, m.attachment_name].filter(Boolean).join(', ');
    return `${who}: ${text}${attach ? ` [attachment: ${attach}]` : ''}`;
  }).filter(Boolean);
  const htmlLines = lines.map(line => `<li>${escHtml(line)}</li>`).join('');
  const textBody = [`Your What's it Doing? consult is now closed.`, vehicle && `Vehicle: ${vehicle}`, issue && `Issue: ${issue}`, `Thread link: ${threadUrl}`, '', 'Thread summary:', ...lines].filter(Boolean).join('\n');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL,
      to: c.customer_email,
      subject: `Completed What's it Doing? consult${c.public_id ? ' — ' + c.public_id : ''}`,
      html: `<p>Your What's it Doing? consult is now closed.</p>${vehicle ? `<p><strong>Vehicle:</strong> ${escHtml(vehicle)}</p>` : ''}${issue ? `<p><strong>Issue:</strong> ${escHtml(issue)}</p>` : ''}<p><a href="${threadUrl}">Open the saved thread</a></p>${htmlLines ? `<p><strong>Thread summary:</strong></p><ul>${htmlLines}</ul>` : ''}`,
      text: textBody
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Closed email send failed');
  return data;
}

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

    let closed_email = null;
    if (status === 'closed') {
      try { closed_email = await sendClosedEmail(event, id); } catch (emailErr) { console.error('closed email failed', emailErr); closed_email = { ok:false, error: emailErr.message || String(emailErr) }; }
    }

    return json(200, { ok: true, consult: Array.isArray(updated) ? updated[0] : updated, closed_email });
  } catch (err) {
    console.error(err);
    return json(err.statusCode || 500, { ok: false, error: err.message || String(err), details: err.details || undefined });
  }
};
