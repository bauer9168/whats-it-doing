const crypto = require('crypto');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function originFromEvent(event) {
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers.host || event.headers.Host;
  if (host) return `${proto}://${host}`;
  return process.env.URL || process.env.DEPLOY_PRIME_URL || 'http://localhost:8888';
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function safeString(value, max = 2000) {
  return String(value || '').slice(0, max);
}

function casePublicId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(2, 12);
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `WID-${stamp}-${rand}`;
}

function priceForQueue(queueType) {
  const q = String(queueType || 'guided').toLowerCase();
  if (q === 'priority') return { amount: 7900, label: 'Priority diagnostic consult' };
  if (q === 'extended') return { amount: 24900, label: 'Extended vehicle thread · 3 days' };
  return { amount: 3900, label: 'Guided diagnostic consult' };
}

async function supabaseRequest(path, options = {}) {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const err = new Error(`Supabase ${response.status}`);
    err.details = data;
    throw err;
  }
  return data;
}

module.exports = { json, originFromEvent, requireEnv, safeString, casePublicId, priceForQueue, supabaseRequest };
