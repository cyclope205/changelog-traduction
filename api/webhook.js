const crypto = require("crypto");

const REPOSITORIES = new Set([
  "changelog-traduction",
  "suivi-stock-pellet",
  "programme-tnt-fr",
  "recettes-express",
]);

// A BMC donation payload is a few hundred bytes. 100 KB leaves generous
// headroom while refusing to buffer an oversized body in memory before
// the HMAC signature even gets a chance to reject it.
const MAX_BODY_BYTES = 100 * 1024;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error("Payload too large");
        err.statusCode = 413;
        // Pause instead of destroy(): destroying the request can tear down
        // the underlying socket before the 413 response gets a chance to
        // be written, leaving the client with a reset connection instead
        // of an actual error response. Pausing just stops us consuming
        // more of the body while the socket (and the response) stay alive.
        if (typeof req.pause === "function") req.pause();
        fail(err);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err) => fail(err);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

function safeEqualHex(a, b) {
  if (!a || !b) return false;
  // Reject anything that isn't exactly 64 hex characters (a SHA-256 HMAC
  // digest) before decoding. Buffer.from(str, "hex") silently truncates
  // at the first invalid pair instead of throwing, so without this check
  // a malformed signature could decode to an unexpected byte length. The
  // length comparison below already prevents that from being exploitable,
  // but validating the format first is the correct, defensive order.
  if (!HEX_64_RE.test(String(a)) || !HEX_64_RE.test(String(b))) return false;
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Escapes Markdown/GFM special characters so untrusted text (a donor's
// display name) can never alter formatting or inject a link/image when
// dropped into README.md.
function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_{}[\]()#+\-.!|<>~])/g, "\\$1");
}

function anonymizeName(name) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) return "Anonymous";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${escapeMarkdown(parts[0])} ${escapeMarkdown(parts[1][0])}*****`;
  }
  return `${escapeMarkdown(clean[0])}*****`;
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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True if `sectionText` already records donation `eventId`. Uses a regex
// with a negative lookahead instead of String#includes so that "evt_1"
// cannot false-positive-match inside "evt_10", "evt_123", etc. — a plain
// substring check would wrongly treat a later, distinct donation as a
// duplicate and silently drop it from the README.
function hasEventId(sectionText, eventId) {
  if (!eventId) return false;
  const pattern = new RegExp(`#${escapeRegExp(eventId)}(?![\\w-])`);
  return pattern.test(sectionText);
}

// Pure function: given the current README text, returns the merged text
// plus whether anything actually changed. Separated from updateReadme()
// so it can be unit tested without mocking fetch, and so the 409-retry
// loop can recompute the merge against a freshly re-fetched README.
function buildReadmeUpdate(current, donation, supporter, eventId) {
  const markerStart = "<!--START_SECTION:buy-me-a-coffee-->";
  const markerEnd = "<!--END_SECTION:buy-me-a-coffee-->";
  const amount = donation.amount ?? supporter?.support_coffee_price ?? "?";
  const currency = donation.currency ?? supporter?.support_currency ?? "";
  const name = anonymizeName(
    donation.supporter_name ||
    supporter?.supporter_name ||
    supporter?.payer_name
  );
  const createdAt = donation.created_at || supporter?.support_created_on || Date.now();
  const date = new Date(
    typeof createdAt === "number" ? createdAt * 1000 : createdAt
  ).toISOString().slice(0, 10);

  const entry = `- ☕ **${name}** — ${amount} ${currency} (${date})${eventId ? ` — #${eventId}` : ""}`;
  const block = `${markerStart}\n${entry}\n${markerEnd}`;

  const start = current.indexOf(markerStart);
  const end = current.indexOf(markerEnd);

  if (start >= 0 && end >= start) {
    const existing = current.slice(start, end);
    if (hasEventId(existing, eventId)) {
      return { updated: current, changed: false };
    }
    return {
      updated: current.slice(0, end) + "\n" + entry + current.slice(end),
      changed: true,
    };
  }

  const section = `\n\n<div align="center">\n\n### ☕ Merci aux donateurs\n\n${block}\n\n</div>\n`;
  const licence = current.search(/^##? Licence$/mi);
  const updated = licence >= 0
    ? current.slice(0, licence) + section + "\n" + current.slice(licence)
    : current.trimEnd() + section;
  return { updated, changed: updated !== current };
}

async function updateReadme(repo, donation, supporter, eventId, attempt = 0) {
  const MAX_ATTEMPTS = 3;
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

  const { updated, changed } = buildReadmeUpdate(current, donation, supporter, eventId);
  if (!changed) return { updated: false };

  const putResponse = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "chore: add Buy Me A Coffee supporter",
      content: Buffer.from(updated, "utf8").toString("base64"),
      sha: file.sha,
      branch: "main",
    }),
  });

  if (putResponse.status === 409) {
    // Another donation's write landed between our GET and PUT, so our sha
    // is stale. Re-fetch the README and retry the merge instead of
    // failing the whole webhook (and silently dropping the donor entry).
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      return updateReadme(repo, donation, supporter, eventId, attempt + 1);
    }
    throw new Error(`GitHub README PUT returned HTTP 409 after ${MAX_ATTEMPTS} attempts`);
  }

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
    if (error && error.statusCode === 413) {
      return res.status(413).json({ error: "Payload too large" });
    }
    console.error("BMC webhook error", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};

// Exposed for unit testing only — not part of the HTTP contract Vercel calls.
module.exports._internal = {
  readRawBody,
  safeEqualHex,
  escapeMarkdown,
  escapeRegExp,
  hasEventId,
  anonymizeName,
  repoFromReferer,
  buildReadmeUpdate,
  updateReadme,
  MAX_BODY_BYTES,
  REPOSITORIES,
};
