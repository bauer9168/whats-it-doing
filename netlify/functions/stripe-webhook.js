const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function siteUrl() {
  return String(process.env.SITE_URL || process.env.URL || "https://whatsitdoing.app").replace(/\/$/, "");
}

function threadUrl(sessionId) {
  return `${siteUrl()}/thread.html?session_id=${encodeURIComponent(sessionId)}`;
}

async function sendThreadEmail(consult, sessionId) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = String((consult && consult.customer_email) || "").trim();
  if (!apiKey || !to) return;

  const from = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL || "What’s it Doing? <consult@whatsitdoing.app>";
  const url = threadUrl(sessionId);
  const vehicle = String((consult && consult.vehicle_summary) || "your vehicle").trim();
  const issue = String((consult && consult.issue_summary) || "your consult").trim();
  const publicId = String((consult && consult.public_id) || "").trim();

  const text = [
    "Your What’s it Doing? consult payment was received.",
    "",
    publicId ? `Consult: ${publicId}` : "",
    `Vehicle: ${vehicle}`,
    `Issue: ${issue}`,
    "",
    "Open your consult thread here:",
    url,
    "",
    "Save this email. This link is your reply thread for follow-up messages, photos, and updates.",
    "",
    "Not live chat. Replies are during business hours."
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#111;max-width:620px;">
      <h2 style="margin:0 0 10px;">Your consult thread is ready</h2>
      <p>Your What’s it Doing? consult payment was received.</p>
      <p><strong>Vehicle:</strong> ${escapeHtml(vehicle)}<br><strong>Issue:</strong> ${escapeHtml(issue)}${publicId ? `<br><strong>Consult:</strong> ${escapeHtml(publicId)}` : ""}</p>
      <p><a href="${url}" style="display:inline-block;background:#244fbe;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:bold;">Open your consult thread</a></p>
      <p style="font-size:13px;color:#555;">Save this email. This link is your reply thread for follow-up messages, photos, and updates.</p>
      <p style="font-size:12px;color:#777;">Not live chat. Replies are during business hours.</p>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: "Your What’s it Doing? consult thread is ready", text, html })
    });
    if (!res.ok) console.error("Resend email failed:", res.status, await res.text());
  } catch (err) {
    console.error("Resend email fatal:", err);
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensurePaidSystemMessage(supabase, consultId) {
  const { data: existing } = await supabase
    .from("consult_messages")
    .select("id")
    .eq("consult_id", consultId)
    .eq("who", "system")
    .ilike("text", "Payment received%")
    .limit(1);
  if (existing && existing.length) return;
  const { error } = await supabase.from("consult_messages").insert({
    consult_id: consultId,
    who: "system",
    text: "Payment received. Your consult thread is open."
  });
  if (error) console.error("Could not insert paid system message:", error);
}

async function backfillOriginalAttachmentMessages(supabase, consult) {
  if (!consult || !consult.id) return;
  const { data: existing } = await supabase
    .from("consult_messages")
    .select("id")
    .eq("consult_id", consult.id)
    .or("text.ilike.Original submission photo%,text.ilike.Original submission audio%,text.ilike.Original submission file%")
    .limit(1);
  if (existing && existing.length) return;

  const rows = [];
  let fileLinks = [];
  if (Array.isArray(consult.file_links)) fileLinks = consult.file_links;
  else if (typeof consult.file_links === "string") { try { const parsed = JSON.parse(consult.file_links); if (Array.isArray(parsed)) fileLinks = parsed; } catch (_) {} }

  for (const item of fileLinks) {
    if (!item || typeof item !== "object") continue;
    const url = String(item.url || item.dataUrl || item.data_url || item.attachment_url || "").trim();
    const name = String(item.name || item.original_name || item.filename || "customer-upload").trim();
    const type = String(item.type || item.mime_type || "").trim();
    if (!url) continue;
    const isImage = /^image\//i.test(type) || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(name);
    const isAudio = /^audio\//i.test(type) || /\.(webm|mp3|m4a|wav|ogg)$/i.test(name);
    const attachmentType = isImage ? "image" : isAudio ? "audio" : "file";
    const row = { consult_id: consult.id, who: "customer", text: attachmentType === "image" ? "Original submission photo" : attachmentType === "audio" ? "Original submission audio note" : "Original submission file", attachment_type: attachmentType, attachment_name: name };
    if (attachmentType === "image") { row.image_data = url; row.image_name = name; }
    else row.attachment_url = url;
    rows.push(row);
  }

  const voiceUrl = String(consult.voice_note_url || "").trim();
  if (voiceUrl) rows.push({ consult_id: consult.id, who: "customer", text: "Original submission audio note", attachment_type: "audio", attachment_name: "customer-audio-note.webm", attachment_url: voiceUrl });

  if (!rows.length) return;
  const { error } = await supabase.from("consult_messages").insert(rows);
  if (error) console.error("Could not backfill original attachment messages:", error);
}

exports.handler = async function (event) {
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return response(500, { ok: false, error: "Missing Stripe webhook config" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return response(500, { ok: false, error: "Missing Supabase config" });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return response(400, { ok: false, error: "Invalid signature" });
    }

    if (stripeEvent.type !== "checkout.session.completed") return response(200, { ok: true, ignored: stripeEvent.type });

    const session = stripeEvent.data.object;
    const consultId = session.metadata && session.metadata.consult_id;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    let query = supabase
      .from("consults")
      .select("id, public_id, customer_email, vehicle_summary, issue_summary, status, payment_status, file_links, upload_paths, voice_note_url, voice_note_path, upload_count, has_voice_note")
      .limit(1);
    if (consultId) query = query.eq("id", consultId);
    else query = query.or("stripe_checkout_session_id.eq." + session.id + ",stripe_session_id.eq." + session.id);

    const { data: consultRows, error: lookupError } = await query;
    if (lookupError) { console.error("Webhook consult lookup failed:", lookupError); return response(500, { ok: false, error: "Consult lookup failed" }); }
    const consult = Array.isArray(consultRows) ? consultRows[0] : null;
    if (!consult) { console.error("No consult for checkout session", session.id); return response(404, { ok: false, error: "Consult not found" }); }

    const { error: updateError } = await supabase
      .from("consults")
      .update({ payment_status: "paid", status: "waiting_on_me", stripe_checkout_session_id: session.id, stripe_session_id: session.id, stripe_payment_intent_id: session.payment_intent || null, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", consult.id);
    if (updateError) console.error("Webhook paid update failed:", updateError);

    await ensurePaidSystemMessage(supabase, consult.id);
    await backfillOriginalAttachmentMessages(supabase, consult);
    await sendThreadEmail(consult, session.id);

    return response(200, { ok: true });
  } catch (err) {
    console.error("stripe-webhook fatal:", err);
    return response(500, { ok: false, error: err && err.message ? err.message : "Webhook failed" });
  }
};
