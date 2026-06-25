const twilio = require("twilio");

function siteUrl() {
  return String(process.env.SITE_URL || process.env.URL || "https://whatsitdoing.app").replace(/\/$/, "");
}

function threadUrl(sessionId) {
  return `${siteUrl()}/thread.html?session_id=${encodeURIComponent(sessionId || "")}`;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return raw;
}

function publicConsultLabel(consult) {
  return String((consult && consult.public_id) || (consult && consult.id) || "").trim();
}

function ownerSmsBody(kind, consult, sessionId, messageText) {
  const publicId = publicConsultLabel(consult);
  const customer = String((consult && consult.customer_name) || "Customer").trim();
  const vehicle = String((consult && consult.vehicle_summary) || "Vehicle not clear").trim();
  const issue = String((consult && consult.issue_summary) || "Issue not clear").trim();
  const queue = String((consult && consult.queue_type) || "").trim();
  const preview = String(messageText || "").trim().replace(/\s+/g, " ").slice(0, 180);

  const header = kind === "customer_reply"
    ? "WID reply waiting on you"
    : "New paid WID consult";

  const lines = [
    header + (publicId ? `: ${publicId}` : ""),
    `Customer: ${customer}`,
    queue ? `Queue: ${queue}` : "",
    `Vehicle: ${vehicle}`,
    `Issue: ${issue}`,
    preview ? `Msg: ${preview}` : "",
    `Operator: ${siteUrl()}/operator`
  ].filter(Boolean);

  return lines.join("\n").slice(0, 1400);
}

async function sendOwnerSms(kind, consult, sessionId, messageText) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = cleanPhone(process.env.TWILIO_FROM_NUMBER);
  const to = cleanPhone(process.env.OWNER_NOTIFY_PHONE || "3607014808");

  if (!sid || !token || !from || !to) {
    console.log("Owner SMS skipped: missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, or OWNER_NOTIFY_PHONE");
    return { ok: false, skipped: true, channel: "sms" };
  }

  try {
    const client = twilio(sid, token);
    const sent = await client.messages.create({
      body: ownerSmsBody(kind, consult, sessionId, messageText),
      from,
      to
    });
    return { ok: true, channel: "sms", sid: sent.sid };
  } catch (err) {
    console.error("Owner SMS failed:", err);
    return { ok: false, channel: "sms", error: err && err.message ? err.message : String(err) };
  }
}

async function sendOwnerEmail(kind, consult, sessionId, messageText) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = String(process.env.OWNER_NOTIFY_EMAIL || "rodgersservicesllc@hotmail.com").trim();

  if (!apiKey || !to) {
    console.log("Owner email skipped: missing RESEND_API_KEY or OWNER_NOTIFY_EMAIL");
    return { ok: false, skipped: true, channel: "email" };
  }

  const from = process.env.RESEND_FROM_EMAIL || process.env.FROM_EMAIL || "What's it Doing? <consult@whatsitdoing.app>";
  const publicId = publicConsultLabel(consult);
  const customer = String((consult && consult.customer_name) || "Customer").trim();
  const vehicle = String((consult && consult.vehicle_summary) || "Vehicle not clear").trim();
  const issue = String((consult && consult.issue_summary) || "Issue not clear").trim();
  const queue = String((consult && consult.queue_type) || "").trim();
  const preview = String(messageText || "").trim().slice(0, 900);
  const isReply = kind === "customer_reply";

  const subject = isReply
    ? `WID reply waiting on you${publicId ? " — " + publicId : ""}`
    : `New paid WID consult${publicId ? " — " + publicId : ""}`;

  const customerThread = sessionId ? threadUrl(sessionId) : siteUrl() + "/operator";

  const text = [
    isReply ? "Customer reply received. Status is now waiting on me." : "New paid consult received. Status is now waiting on me.",
    "",
    publicId ? `Consult: ${publicId}` : "",
    `Customer: ${customer}`,
    queue ? `Queue: ${queue}` : "",
    `Vehicle: ${vehicle}`,
    `Issue: ${issue}`,
    preview ? "" : "",
    preview ? "Message preview:" : "",
    preview,
    "",
    "Open operator:",
    siteUrl() + "/operator",
    "",
    "Open customer thread:",
    customerThread
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#111;max-width:620px;">
      <h2 style="margin:0 0 10px;">${isReply ? "Customer reply waiting on you" : "New paid consult"}</h2>
      <p>
        <strong>Consult:</strong> ${escapeHtml(publicId || "Not assigned")}<br>
        <strong>Customer:</strong> ${escapeHtml(customer)}<br>
        ${queue ? `<strong>Queue:</strong> ${escapeHtml(queue)}<br>` : ""}
        <strong>Vehicle:</strong> ${escapeHtml(vehicle)}<br>
        <strong>Issue:</strong> ${escapeHtml(issue)}
      </p>
      ${preview ? `<p><strong>Message preview:</strong><br>${escapeHtml(preview)}</p>` : ""}
      <p><a href="${siteUrl()}/operator" style="display:inline-block;background:#244fbe;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:bold;">Open operator page</a></p>
      <p style="font-size:13px;color:#555;">Customer thread: <a href="${customerThread}">${escapeHtml(customerThread)}</a></p>
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text, html })
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("Owner email failed:", res.status, body);
      return { ok: false, channel: "email", status: res.status, body };
    }

    return { ok: true, channel: "email" };
  } catch (err) {
    console.error("Owner email fatal:", err);
    return { ok: false, channel: "email", error: err && err.message ? err.message : String(err) };
  }
}

async function notifyOwner(kind, consult, sessionId, messageText) {
  const results = [];

  // SMS first because it is less likely to be missed.
  results.push(await sendOwnerSms(kind, consult, sessionId, messageText));

  // Email fallback/backup. Leave OWNER_NOTIFY_EMAIL set even after SMS works.
  results.push(await sendOwnerEmail(kind, consult, sessionId, messageText));

  return results;
}

module.exports = {
  siteUrl,
  threadUrl,
  escapeHtml,
  notifyOwner
};
