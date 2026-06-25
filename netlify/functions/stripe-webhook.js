const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { notifyOwner, siteUrl, threadUrl, escapeHtml } = require("./_notify-owner");

const responseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function response(statusCode, payload) {
  return { statusCode, headers: responseHeaders, body: JSON.stringify(payload) };
}

function customerEmailFromSession(session, consult) {
  return (
    (session && session.customer_details && session.customer_details.email) ||
    (session && session.customer_email) ||
    (consult && consult.customer_email) ||
    ""
  );
}

function normalizeAttachmentType(value, name) {
  const combined = `${value || ""} ${name || ""}`;
  if (/image\//i.test(combined) || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(combined)) return "image";
  if (/audio\//i.test(combined) || /\.(webm|mp3|m4a|wav|ogg)$/i.test(combined)) return "audio";
  return "file";
}

async function ensurePaidSystemMessage(supabase, consultId) {
  const { data: existing, error: checkError } = await supabase
    .from("consult_messages")
    .select("id")
    .eq("consult_id", consultId)
    .eq("who", "system")
    .ilike("text", "%Payment received%")
    .limit(1);

  if (checkError) {
    console.error("Paid system message check failed:", checkError);
    return;
  }

  if (Array.isArray(existing) && existing.length) return;

  const { error } = await supabase.from("consult_messages").insert({
    consult_id: consultId,
    who: "system",
    text: "Payment received. Your consult thread is open."
  });

  if (error) console.error("Paid system message insert failed:", error);
}

async function backfillOriginalAttachmentMessages(supabase, consult) {
  if (!consult || !consult.id) return;

  const rows = [];

  const files = Array.isArray(consult.file_links) ? consult.file_links : [];
  files.forEach((file, index) => {
    const name = String(file.name || file.original_name || file.path || `upload-${index + 1}`).slice(0, 128);
    const type = normalizeAttachmentType(file.type || file.mime_type || "", name);
    const url = String(file.url || file.dataUrl || file.data_url || "").trim();

    if (!url) return;

    const row = {
      consult_id: consult.id,
      who: "customer",
      text: type === "image" ? "Original submission photo" : type === "audio" ? "Original submission audio note" : "Original submission file",
      attachment_type: type,
      attachment_name: name
    };

    if (type === "image") {
      row.image_data = url;
      row.image_name = name;
    } else {
      row.attachment_url = url;
    }

    rows.push(row);
  });

  const uploadPaths = Array.isArray(consult.upload_paths) ? consult.upload_paths : [];
  uploadPaths.forEach((path, index) => {
    const name = String(path || `upload-path-${index + 1}`).split("/").pop().slice(0, 128);
    rows.push({
      consult_id: consult.id,
      who: "customer",
      text: "Original submission file",
      attachment_type: normalizeAttachmentType("", name),
      attachment_name: name,
      attachment_url: String(path || "")
    });
  });

  const voiceUrl = String(consult.voice_note_url || consult.voice_note_path || "").trim();
  if (voiceUrl) {
    rows.push({
      consult_id: consult.id,
      who: "customer",
      text: "Original submission audio note",
      attachment_type: "audio",
      attachment_name: "customer-audio-note.webm",
      attachment_url: voiceUrl
    });
  }

  if (!rows.length) return;

  const { data: existing, error: existingError } = await supabase
    .from("consult_messages")
    .select("id, text, attachment_type")
    .eq("consult_id", consult.id)
    .in("attachment_type", ["image", "audio", "file"])
    .limit(10);

  if (existingError) {
    console.error("Attachment backfill existing check failed:", existingError);
    return;
  }

  if (Array.isArray(existing) && existing.length) return;

  const { error } = await supabase.from("consult_messages").insert(rows);
  if (error) console.error("Attachment backfill insert failed:", error);
}

async function sendThreadEmail(consult, sessionId) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = String((consult && consult.customer_email) || "").trim();
  if (!apiKey || !to) return;

  const from = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL || "What's it Doing? <consult@whatsitdoing.app>";
  const publicId = String((consult && consult.public_id) || "").trim();
  const vehicle = String((consult && consult.vehicle_summary) || "your vehicle").trim();
  const issue = String((consult && consult.issue_summary) || "your concern").trim();
  const url = threadUrl(sessionId);

  const subject = `Your What's it Doing? consult is open${publicId ? " — " + publicId : ""}`;

  const text = [
    "Payment received. Your consult thread is open.",
    "",
    publicId ? `Consult: ${publicId}` : "",
    `Vehicle: ${vehicle}`,
    `Issue: ${issue}`,
    "",
    "Open your thread:",
    url,
    "",
    "Please keep replies for this same issue in the thread."
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#111;max-width:620px;">
      <h2 style="margin:0 0 10px;">Your consult thread is open</h2>
      <p><strong>Consult:</strong> ${escapeHtml(publicId || "Not assigned")}<br>
      <strong>Vehicle:</strong> ${escapeHtml(vehicle)}<br>
      <strong>Issue:</strong> ${escapeHtml(issue)}</p>
      <p><a href="${url}" style="display:inline-block;background:#244fbe;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:bold;">Open your thread</a></p>
      <p style="font-size:13px;color:#555;">Please keep replies for this same issue in the thread.</p>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text, html })
    });
    if (!res.ok) console.error("Customer thread email failed:", res.status, await res.text());
  } catch (err) {
    console.error("Customer thread email fatal:", err);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return response(200, { ok: true });
  if (event.httpMethod !== "POST") return response(405, { ok: false, error: "Method not allowed" });

  try {
    if (!process.env.STRIPE_SECRET_KEY) return response(500, { ok: false, error: "Missing STRIPE_SECRET_KEY" });
    if (!process.env.STRIPE_WEBHOOK_SECRET) return response(500, { ok: false, error: "Missing STRIPE_WEBHOOK_SECRET" });
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return response(500, { ok: false, error: "Missing Supabase config" });
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const signature = event.headers["stripe-signature"];
    let stripeEvent;

    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature failed:", err);
      return response(400, { ok: false, error: "Webhook signature verification failed" });
    }

    if (stripeEvent.type !== "checkout.session.completed") {
      return response(200, { ok: true, ignored: stripeEvent.type });
    }

    const session = stripeEvent.data.object;
    const consultId = session && session.metadata ? session.metadata.consult_id : "";

    if (!consultId) {
      console.error("checkout.session.completed missing consult_id metadata");
      return response(400, { ok: false, error: "Missing consult_id metadata" });
    }

    const { data: existingConsult, error: readError } = await supabase
      .from("consults")
      .select("id, public_id, customer_name, customer_email, vehicle_summary, issue_summary, queue_type, status, payment_status, file_links, upload_paths, voice_note_url, voice_note_path, upload_count, has_voice_note, stripe_session_id, stripe_checkout_session_id")
      .eq("id", consultId)
      .single();

    if (readError || !existingConsult) {
      console.error("Consult read failed:", readError);
      return response(500, { ok: false, error: "Could not read consult" });
    }

    const customerEmail = customerEmailFromSession(session, existingConsult);

    const updatePayload = {
      payment_status: "paid",
      status: "waiting_on_me",
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stripe_checkout_session_id: session.id,
      stripe_session_id: session.id
    };

    if (customerEmail && !existingConsult.customer_email) updatePayload.customer_email = customerEmail;

    const { data: updatedConsult, error: updateError } = await supabase
      .from("consults")
      .update(updatePayload)
      .eq("id", consultId)
      .select("id, public_id, customer_name, customer_email, vehicle_summary, issue_summary, queue_type, status, payment_status, file_links, upload_paths, voice_note_url, voice_note_path, upload_count, has_voice_note, stripe_session_id, stripe_checkout_session_id")
      .single();

    if (updateError) {
      console.error("Consult paid update failed:", updateError);
      return response(500, { ok: false, error: "Could not mark consult paid" });
    }

    const consult = updatedConsult || existingConsult;
    if (customerEmail && !consult.customer_email) consult.customer_email = customerEmail;

    await ensurePaidSystemMessage(supabase, consult.id);
    await backfillOriginalAttachmentMessages(supabase, consult);
    await sendThreadEmail(consult, session.id);
    await notifyOwner("new_paid_consult", consult, session.id, "");

    return response(200, { ok: true });
  } catch (err) {
    console.error("stripe-webhook fatal:", err);
    return response(500, { ok: false, error: err && err.message ? err.message : "Webhook failed" });
  }
};
