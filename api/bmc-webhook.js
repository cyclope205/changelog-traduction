const crypto = require("crypto");

function verifySignature(rawBody, secret, signature) {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");

  const signature = req.headers["x-signature-sha256"];
  const secret = process.env.BMC_WEBHOOK_SECRET;

  if (!verifySignature(rawBody, secret, signature)) {
    return res.status(401).json({ ok: false, error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  console.log("BMC webhook received:", {
    event_id: event.event_id,
    type: event.type,
    live_mode: event.live_mode,
    created: event.created,
  });

  return res.status(200).json({ ok: true });
};
