const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const responseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function sendJson(statusCode, payload) {
  return { statusCode, headers: responseHeaders, body: JSON.stringify(payload) };
}

function siteOrigin(event) {
  const envSite = String(process.env.SITE_URL || process.env.URL || "").replace(/\/$/, "");
  if (envSite) return envSite;
  const host = event.headers["x-forwarded-host"] || event.headers.host || "whatsitdoing.app";
  const proto = event.headers["x-forwarded-proto"] || "https";
  return proto + "://" + host;
}

function amountForQueue(queueType) {
  const q = String(queueType || "guided").toLowerCase();
  if (q.includes("priority") || q.includes("rush")) return Number(process.env.CONSULT_PRIORITY_AMOUNT_CENTS || process.env.CONSULT_RUSH_AMOUNT_CENTS || 7900);
  if (q.includes("extended")) return Number(process.env.CONSULT_EXTENDED_AMOUNT_CENTS || 24900);
  return Number(process.env.CONSULT_NORMAL_AMOUNT_CENTS || 3900);
}

function labelForQueue(queueType) {
  const q = String(queueType || "guided").toLowerCase();
  if (q.includes("priority") || q.includes("rush")) return "Rush diagnostic consult";
  if (q.includes("extended")) return "Extended thread diagnostic consult";
  return "Normal diagnostic consult";
}

function normalizeUpload(item, fallbackIndex) {
  if (!item || typeof item !== "object") return null;
  const name = String(item.name || item.original_name || `upload-${fallbackIndex}`).slice(0, 128);
  const type = String(item.type || item.mime_type || "application/octet-stream").slice(0, 128);
  const dataUrl = String(item.dataUrl || item.data_url || item.url || "");
  const size = Number(item.size || 0);
  const skipped = !!item.skipped_inline;
  const note = String(item.note || "").slice(0, 300);
  return { name, original_name: String(item.original_name || name).slice(0, 128), type, dataUrl, size, skipped_inline: skipped, note };
}

function attachmentTypeFor(upload) {
  const nameType = ((upload && upload.name) || "") + " " + ((upload && upload.type) || "");
  if (/image\//i.test(nameType) || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(nameType)) return "image";
  if (/audio\//i.test(nameType) || /\.(webm|mp3|m4a|wav|ogg)$/i.test(nameType)) return "audio";
  if (/pdf|text|csv/i.test(nameType)) return "file";
  return "file";
}

async function insertInitialMessages(supabase, consult, payload) {
  const rows = [];
  const intakeText = String(payload.intake_text || "").trim();
  const followupText = String(payload.followup_text || "").trim();

  if (intakeText || followupText) {
    rows.push({
      consult_id: consult.id,
      who: "customer",
      text: [intakeText && `Original description:\n${intakeText}`, followupText && `Additional details:\n${followupText}`].filter(Boolean).join("\n\n")
    });
  }

  const uploads = Array.isArray(payload.uploads) ? payload.uploads.map(normalizeUpload).filter(Boolean) : [];
  for (let i = 0; i < uploads.length; i++) {
    const upload = normalizeUpload(uploads[i], i + 1);
    if (!upload) continue;
    const attachmentType = attachmentTypeFor(upload);
    if (upload.dataUrl) {
      const row = {
        consult_id: consult.id,
        who: "customer",
        text: attachmentType === "image" ? "Original submission photo" : attachmentType === "audio" ? "Original submission audio note" : "Original submission file",
        attachment_type: attachmentType,
        attachment_name: upload.original_name || upload.name
      };
      if (attachmentType === "image") {
        row.image_data = upload.dataUrl;
        row.image_name = upload.original_name || upload.name;
      } else {
        row.attachment_url = upload.dataUrl;
      }
      rows.push(row);
    } else if (upload.skipped_inline) {
      rows.push({
        consult_id: consult.id,
        who: "customer",
        text: `Original submission file selected: ${upload.original_name || upload.name}${upload.note ? "\n" + upload.note : ""}`,
        attachment_type: "file",
        attachment_name: upload.original_name || upload.name
      });
    }
  }

  const voice = payload.voice_note && typeof payload.voice_note === "object" ? payload.voice_note : null;
  const voiceDataUrl = voice ? String(voice.dataUrl || voice.data_url || "") : "";
  if (voiceDataUrl) {
    rows.push({
      consult_id: consult.id,
      who: "customer",
      text: "Original submission audio note",
      attachment_type: "audio",
      attachment_name: String(voice.original_name || voice.name || "customer-audio-note.webm").slice(0, 128),
      attachment_url: voiceDataUrl
    });
  }

  if (!rows.length) return;
  const { error } = await supabase.from("consult_messages").insert(rows);
  if (error) console.error("Initial consult_messages insert failed:", error);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return sendJson(200, { ok: true });
  if (event.httpMethod !== "POST") return sendJson(405, { ok: false, error: "Method not allowed" });

  try {
    if (!process.env.STRIPE_SECRET_KEY) return sendJson(500, { ok: false, error: "Missing STRIPE_SECRET_KEY" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return sendJson(500, { ok: false, error: "Missing Supabase config" });

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const payload = JSON.parse(event.body || "{}");

    const uploads = Array.isArray(payload.uploads) ? payload.uploads.map(normalizeUpload).filter(Boolean) : [];
    const voice = payload.voice_note && typeof payload.voice_note === "object" ? payload.voice_note : null;
    const fileLinks = uploads.map(u => ({
      name: u.original_name || u.name,
      type: u.type,
      size: u.size,
      inline: !!u.dataUrl,
      skipped_inline: !!u.skipped_inline
    }));

    const consultPayload = {
      customer_name: payload.customer_name || null,
      customer_email: payload.customer_email || null,
      phone_ok: !!payload.phone_ok,
      customer_phone: payload.customer_phone || null,
      vehicle_summary: payload.vehicle_summary || null,
      issue_summary: payload.issue_summary || null,
      work_done_summary: payload.work_done_summary || null,
      diy_status: payload.diy_status || null,
      ability_level: payload.ability_level || null,
      intake_text: payload.intake_text || null,
      followup_text: payload.followup_text || null,
      queue_type: payload.queue_type || "guided",
      payment_status: "unpaid",
      status: "unpaid",
      upload_count: Number(payload.upload_count || uploads.length || 0),
      has_voice_note: !!(payload.has_voice_note || voice),
      file_links: fileLinks,
      voice_note_url: voice && voice.dataUrl ? String(voice.dataUrl) : null,
      updated_at: new Date().toISOString()
    };

    const { data: consult, error: consultError } = await supabase
      .from("consults")
      .insert(consultPayload)
      .select("id, public_id, customer_email, vehicle_summary, issue_summary, queue_type")
      .single();

    if (consultError) {
      console.error("Consult insert failed:", consultError);
      return sendJson(500, { ok: false, error: "Could not create consult", details: consultError });
    }

    await insertInitialMessages(supabase, consult, payload);

    const origin = siteOrigin(event);
    const successUrl = `${origin}/thread.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/?checkout=cancelled&consult_id=${encodeURIComponent(consult.id)}`;
    const amount = amountForQueue(payload.queue_type);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: payload.customer_email || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { consult_id: consult.id, public_id: consult.public_id || "", queue_type: payload.queue_type || "guided" },
      payment_intent_data: { metadata: { consult_id: consult.id, public_id: consult.public_id || "" } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: String(process.env.CONSULT_CURRENCY || "usd").toLowerCase(),
          unit_amount: amount,
          product_data: { name: labelForQueue(payload.queue_type) }
        }
      }]
    });

    const { error: updateError } = await supabase
      .from("consults")
      .update({ stripe_checkout_session_id: session.id, stripe_session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", consult.id);
    if (updateError) console.error("Could not save checkout session id:", updateError);

    return sendJson(200, { ok: true, checkout_url: session.url, session_id: session.id, consult_id: consult.id, consult });
  } catch (err) {
    console.error("create-checkout-session fatal:", err);
    return sendJson(500, { ok: false, error: err && err.message ? err.message : "Could not create checkout session" });
  }
};
