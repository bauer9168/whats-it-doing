const { createClient } = require("@supabase/supabase-js");

const responseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-operator-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function sendJson(statusCode, payload) {
  return {
    statusCode,
    headers: responseHeaders,
    body: JSON.stringify(payload)
  };
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const lowerName = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }

  return "";
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
      return sendJson(400, { ok: false, error: "Invalid JSON body" });
    }

    const expectedPin = String(process.env.OPERATOR_PIN || "").trim();
    const suppliedPin = String(
      payload.pin ||
      payload.operator_pin ||
      getHeader(event, "x-operator-pin") ||
      ""
    ).trim();

    if (expectedPin && suppliedPin !== expectedPin) {
      console.error("Invalid operator PIN");
      return sendJson(401, { ok: false, error: "Invalid operator PIN" });
    }

    const consultKey = String(
      payload.consult_id ||
      payload.id ||
      payload.public_id ||
      payload.case_id ||
      ""
    ).trim();

    const replyText = String(
      payload.text ||
      payload.message ||
      payload.body ||
      payload.reply ||
      ""
    ).trim();

    const imageData = String(payload.imageData || payload.image_data || "").trim();
    const imageName = String(payload.imageName || payload.image_name || payload.attachment_name || "").trim();

    if (!consultKey) {
      return sendJson(400, { ok: false, error: "Missing consult_id" });
    }

    if (!replyText && !imageData) {
      return sendJson(400, { ok: false, error: "Missing reply text" });
    }

    let query = supabase
      .from("consults")
      .select("id, public_id, status");

    if (looksLikeUuid(consultKey)) {
      query = query.eq("id", consultKey);
    } else {
      query = query.eq("public_id", consultKey);
    }

    const { data: consult, error: lookupError } = await query.maybeSingle();

    if (lookupError) {
      console.error("Operator consult lookup failed:", lookupError);
      return sendJson(500, { ok: false, error: "Could not load consult" });
    }

    if (!consult) {
      console.error("No consult found for operator key:", consultKey);
      return sendJson(404, { ok: false, error: "Consult not found" });
    }

    const status = String(consult.status || "").toLowerCase();

    if (status.includes("closed") || status.includes("archiv")) {
      return sendJson(403, { ok: false, error: "This consult is closed" });
    }

    const insertPayload = {
      consult_id: consult.id,
      who: "operator",
      text: replyText || ""
    };

    if (imageData) {
      insertPayload.image_data = imageData;
      insertPayload.image_name = imageName || "operator-picture.jpg";
      insertPayload.attachment_type = "image";
      insertPayload.attachment_name = imageName || "operator-picture.jpg";
    }

    const { data: insertedMessage, error: insertError } = await supabase
      .from("consult_messages")
      .insert(insertPayload)
      .select("id, consult_id, who, text, image_data, image_name, attachment_type, attachment_name, created_at")
      .single();

    if (insertError) {
      console.error("Operator consult_messages insert failed:", insertError);
      return sendJson(500, { ok: false, error: "Could not send reply" });
    }

    const lastMessage = replyText || (imageData ? "Picture attached" : "Operator reply");

    const { error: updateError } = await supabase
      .from("consults")
      .update({
        last_message: lastMessage,
        last_message_at: new Date().toISOString(),
        status: "waiting_on_customer",
        updated_at: new Date().toISOString()
      })
      .eq("id", consult.id);

    if (updateError) {
      console.error("Operator consult summary update failed:", updateError);
    }

    return sendJson(200, {
      ok: true,
      message: insertedMessage
    });
  } catch (err) {
    console.error("post-operator-message fatal:", err);
    return sendJson(500, {
      ok: false,
      error: err && err.message ? err.message : "Could not send reply"
    });
  }
};
