const crypto = require("crypto");

const REPOSITORIES = new Set([
  "changelog-traduction",
  "suivi-stock-pellet",
  "programme-tnt-fr",
  "recettes-express",
]);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeEqualHex(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function anonymizeName(name) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) return "Anonymous";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[1][0]}*****`;
  return clean[0] + "*****";
}

function repoFromReferer(referer) {
  if (!referer || typeof referer !== "string") return null;

  try {
    const url = new URL(referer);
    const explicit = url.searchParams.get("repo");
    if (explicit && REPOSITORIES.has(explicit)) return explicit;
  } catch {}

  const match = referer.match(/github\.com\/cyclope205\/([a-z0-9._-]+)/i);
  if (match && REPOSITORIES.has(match[1])) return match[1];

  for (const repo of REPOSITORIES) {
    if (referer.includes(`cyclope205/${repo}`)) return repo;
  }
  return null;
}

async function bmcGetSupporter(supporterId) {
  const token = process.env.BMC_API_TOKEN || process.env.BMC_TOKEN;
  if (!token || !supporterId) return null;

  const response = await fetch(
    `https://developers.buymeacoffee.com/api/v1/supporters/${encodeURIComponent(supporterId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`BMC API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return payload?.data || payload?.supporter || payload || null;
}

async function updateReadme(repo, donation, supporter, eventId) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured");

  const apiUrl = `https://api.github.com/repos/cyclope205/${repo}/contents/README.md`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
  };

  const readmeResponse = await fetch(apiUrl, { headers });
  if (!readmeResponse.ok) {
    throw new Error(`GitHub README GET returned HTTP ${readmeResponse.status}`);
  }

  const file = await readmeResponse.json();
  const current = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");

  const markerStart = "<!--START_SECTION:buy-me-a-coffee-->";
  const markerEnd = "<!--END_SECTION:buy-me-a-coffee-->";
  const amount = donation.amount ?? supporter?.support_coffee_price ?? "?";
  const currency = donation.currency ?? supporter?.support_currency ?? "";
  const name = anonymizeName(
    donation.supporter_name ||
    supporter?.supporter_name ||
    supporter?.payer_name
  );
  const date = new Date(
    Number(donation.created_at || supporter?.support_created_on || Date.now()) *
      (String(donation.created_at || supporter?.support_created_on || "").length <= 10 ? 1000 : 1)
  ).toISOString().slice(0, 10);

  const entry = `- ☕ **${name}** — ${amount} ${currency} (${date})${eventId ? ` — #${eventId}` : ""}`;
  const block = `${markerStart}\n${entry}\n${markerEnd}`;

  let updated;
  const start = current.indexOf(markerStart);
  const end = current.indexOf(markerEnd);

  if (start >= 0 && end >= start) {
    const existing = current.slice(start, end);
    if (eventId && existing.includes("#" + eventId)) return { updated: false };
    updated = current.slice(0, end) + "\n" + entry + current.slice(end);
  } else {
    const section = `\n\n<div align="center">\n\n### ☕ Merci aux donateurs\n\n${block}\n\n</div>\n`;
    const licence = current.search(/^##? Licence$/mi);
    updated = licence >= 0
      ? current.slice(0, licence) + section + "\n" + current.slice(licence)
      : current.trimEnd() + section;
  }

  if (updated === current) return { updated: false };

  const putResponse = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `chore: add Buy Me A Coffee supporter`,
      content: Buffer.from(updated, "utf8").toString("base64"),
      sha: file.sha,
      branch: "main",
    }),
  });

  if (!putResponse.ok) {
    const body = await putResponse.text();
    throw new Error(`GitHub README PUT returned HTTP ${putResponse.status}: ${body.slice(0, 300)}`);
  }

  return { updated: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.BMC_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "BMC_WEBHOOK_SECRET is not configured" });

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["x-signature-sha256"];
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    if (!safeEqualHex(signature, expected)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    if (!event?.type) return res.status(400).json({ error: "Invalid webhook event" });

    if (event.type !== "donation.created" || event.live_mode === false) {
      return res.status(200).json({
        ok: true,
        event_id: event.event_id ?? null,
        type: event.type,
        ignored: true,
      });
    }

    const donation = event.data || {};
    const supporterId = donation.supporter_id;
    const supporter = await bmcGetSupporter(supporterId);
    const referer = supporter?.referer || supporter?.referrer || "";
    const repo = repoFromReferer(referer);

    if (!repo) {
      console.warn("BMC donation received without reliable repository attribution", {
        event_id: event.event_id,
        supporter_id: supporterId ?? null,
        referer,
      });
      return res.status(200).json({
        ok: true,
        event_id: event.event_id ?? null,
        attributed: false,
      });
    }

    const result = await updateReadme(repo, donation, supporter, event.event_id);

    console.log("BMC donation attributed", {
      event_id: event.event_id,
      supporter_id: supporterId,
      repo,
      updated: result.updated,
    });

    return res.status(200).json({
      ok: true,
      event_id: event.event_id ?? null,
      attributed: true,
      repository: repo,
      updated: result.updated,
    });
  } catch (error) {
    console.error("BMC webhook error", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
