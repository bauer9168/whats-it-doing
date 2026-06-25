const { createClient } = require("@supabase/supabase-js");

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.error("Missing Supabase environment variables");
      return json(500, { ok: false, error: "Server is missing Supabase config" });
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    const payload = JSON.parse(event.body || "{}");
    const sessionId = String(payload.session_id || payload.session || "").trim();
    const messageText = String(payload.text || payload.message || payload.body || "").trim();

    if (!sessionId) {
      return json(400, { ok: false, error: "Missing session_id" });
    }

    if (!messageText) {
      return json(400, { ok: false, error: "Missing message text" });
    }

    // Support both old and new Stripe session column names.
    const { data: consults, error: lookupError } = await supabase
      .from("consults")
      .select("id, public_id, status, payment_status, stripe_session_id, stripe_checkout_session_id")
      .or(`stripe_checkout_session_id.eq.${sessionId},stripe_session_id.eq.${sessionId}`)
      .limit(1);

    if (lookupError) {
      console.error("Consult lookup failed:", lookupError);
      return json(500, { ok: false, error: "Could not find consult" });
    }

    const consult = Array.isArray(consults) ? consults[0] : null;

    if (!consult) {
      console.error("No consult found for session_id:", sessionId);
      return json(404, { ok: false, error: "Consult not found for this session" });
    }

    const status = String(consult.status || "").toLowerCase();

    if (status.includes("closed") || status.includes("archiv")) {
      return json(403, { ok: false, error: "This consult is closed" });
    }

    // Your actual table schema is consult_id / who / text.
    const { data: insertedMessage, error: insertError } = await supabase
      .from("consult_messages")
      .insert({
        consult_id: consult.id,
        who: "customer",
        text: messageText
      })
      .select("id, consult_id, who, text, created_at")
      .single();

    if (insertError) {
      console.error("consult_messages insert failed:", insertError);
      return json(500, { ok: false, error: "Could not send message" });
    }

    // Keep consult row summary/status updated for operator lists.
    const { error: updateError } = await supabase
      .from("consults")
      .update({
        last_message: messageText,
        last_message_at: new Date().toISOString(),
        status: "waiting_on_me",
        updated_at: new Date().toISOString()
      })
      .eq("id", consult.id);

    if (updateError) {
      // Do not fail the send if only the summary update fails.
      console.error("consults summary update failed:", updateError);
    }

    return json(200, {
      ok: true,
      message: insertedMessage
    });
  } catch (err) {
    console.error("post-customer-message fatal error:", err);
    return json(500, {
      ok: false,
      error: err.message || "Could not send message"
    });
  }
};
