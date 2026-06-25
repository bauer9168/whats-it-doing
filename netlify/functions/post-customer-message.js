const { createClient } = require("@supabase/supabase-js");

const responseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function sendJson(statusCode, payload) {
  return {
    statusCode,
    headers: responseHeaders,
    body: JSON.stringify(payload)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return sendJson(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return sendJson(405, { ok: false, error: "Method not allowed" });
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error("Missing Supabase env vars");
      return sendJson(500, { ok: false, error: "Server missing Supabase config" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (parseError) {
      console.error("Invalid JSON body:", parseError);
      return sendJson(400, { ok: false, error: "Invalid JSON body" });
    }

    const sessionId = String(payload.session_id || payload.session || "").trim();
    const messageText = String(payload.text || payload.message || payload.body || "").trim();

    const imageData = String(payload.imageData || payload.image_data || "").trim();
    const imageName = String(
      payload.imageName ||
      payload.image_name ||
      payload.attachment_name ||
      ""
    ).trim();

    const attachmentUrl = String(
      payload.attachmentUrl ||
      payload.attachment_url ||
      ""
    ).trim();

    const attachmentType = String(
      payload.attachmentType ||
      payload.attachment_type ||
      (imageData ? "image" : "")
    ).trim();

    const attachmentName = String(
      payload.attachmentName ||
      payload.attachment_name ||
      imageName ||
      ""
    ).trim();

    if (!sessionId) {
      return sendJson(400, { ok: false, error: "Missing session_id" });
    }

    if (!messageText && !imageData && !attachmentUrl) {
      return sendJson(400, { ok: false, error: "Missing message text" });
    }

    const { data: consultRows, error: lookupError } = await supabase
      .from("consults")
      .select("id, public_id, status, payment_status, stripe_session_id, stripe_checkout_session_id")
      .or("stripe_checkout_session_id.eq." + sessionId + ",stripe_session_id.eq." + sessionId)
      .limit(1);

    if (lookupError) {
      console.error("Consult lookup failed:", lookupError);
      return sendJson(500, { ok: false, error: "Could not find consult" });
    }

    const consult = Array.isArray(consultRows) ? consultRows[0] : null;

    if (!consult) {
      console.error("No consult found for session_id:", sessionId);
      return sendJson(404, { ok: false, error: "Consult not found for this session" });
    }

    const status = String(consult.status || "").toLowerCase();

    if (status.indexOf("closed") !== -1 || status.indexOf("archiv") !== -1) {
      return sendJson(403, { ok: false, error: "This consult is closed" });
    }

    const insertPayload = {
      consult_id: consult.id,
      who: "customer",
      text: messageText || ""
    };

    if (imageData) {
      insertPayload.image_data = imageData;
      insertPayload.image_name = imageName || attachmentName || "customer-photo.jpg";
      insertPayload.attachment_type = attachmentType || "image";
      insertPayload.attachment_name = attachmentName || imageName || "customer-photo.jpg";
    }

    if (attachmentUrl) {
      insertPayload.attachment_url = attachmentUrl;
      insertPayload.attachment_type = attachmentType || "file";
      insertPayload.attachment_name = attachmentName || imageName || "customer-attachment";
    }

    const { data: insertedMessage, error: insertError } = await supabase
      .from("consult_messages")
      .insert(insertPayload)
      .select(
        "id, consult_id, who, text, image_data, image_name, attachment_type, attachment_name, attachment_url, created_at"
      )
      .single();

    if (insertError) {
      console.error("consult_messages insert failed:", insertError);
      return sendJson(500, { ok: false, error: "Could not send message" });
    }

    const lastMessage =
      messageText ||
      (imageData ? "Picture attached" : "") ||
      (attachmentUrl ? "Attachment added" : "") ||
      "Customer message";

    const { error: updateError } = await supabase
      .from("consults")
      .update({
        last_message: lastMessage,
        last_message_at: new Date().toISOString(),
        status: "waiting_on_me",
        updated_at: new Date().toISOString()
      })
      .eq("id", consult.id);

    if (updateError) {
      console.error("consults summary update failed:", updateError);
    }

    return sendJson(200, {
      ok: true,
      message: insertedMessage
    });
  } catch (err) {
    console.error("post-customer-message fatal:", err);
    return sendJson(500, {
      ok: false,
      error: err && err.message ? err.message : "Could not send message"
    });
  }
};
