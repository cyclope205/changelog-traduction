// Run with: node --test tests/webhook.test.js
// Node's built-in test runner (Node >= 18) — no new dependency added,
// consistent with api/webhook.js itself having zero external deps.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const http = require("node:http");

const handler = require("../api/webhook.js");
const {
  safeEqualHex,
  escapeMarkdown,
  hasEventId,
  anonymizeName,
  repoFromReferer,
  buildReadmeUpdate,
  updateReadme,
  MAX_BODY_BYTES,
} = handler._internal;

const SECRET = "test-secret";

function sign(bodyString) {
  return crypto.createHmac("sha256", SECRET).update(bodyString).digest("hex");
}

function makeReq({ method = "POST", headers = {}, chunks = [] }) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  req.destroy = () => { req.destroyed = true; };
  req.pause = () => { req.paused = true; };
  process.nextTick(() => {
    for (const chunk of chunks) req.emit("data", Buffer.from(chunk));
    if (!req.destroyed) req.emit("end");
  });
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
  };
}

async function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function mockFetchQueue(responses) {
  const original = global.fetch;
  let i = 0;
  global.fetch = async (...args) => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === "function" ? next(...args) : next;
  };
  return () => { global.fetch = original; };
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

test("safeEqualHex rejects mismatched or missing signatures", () => {
  assert.equal(safeEqualHex("abcd", "abce"), false);
  assert.equal(safeEqualHex(null, "abcd"), false);
  assert.equal(safeEqualHex("", ""), false);
});

test("safeEqualHex accepts matching signatures", () => {
  const hex = crypto.createHmac("sha256", "x").update("y").digest("hex");
  assert.equal(safeEqualHex(hex, hex), true);
});

test("safeEqualHex rejects a signature that isn't exactly 64 hex characters (P2a)", () => {
  const valid = crypto.createHmac("sha256", "x").update("y").digest("hex");
  assert.equal(safeEqualHex("abc", valid), false); // too short
  assert.equal(safeEqualHex(valid + "00", valid), false); // too long
  assert.equal(safeEqualHex("z".repeat(64), valid), false); // right length, not hex
  assert.equal(safeEqualHex(valid.slice(0, 63) + "g", valid), false); // one invalid char
});

test("escapeMarkdown escapes GFM special characters", () => {
  assert.equal(escapeMarkdown("[a](b)"), "\\[a\\]\\(b\\)");
  assert.equal(escapeMarkdown("*bold* _em_"), "\\*bold\\* \\_em\\_");
  assert.equal(escapeMarkdown("plain text"), "plain text");
});

test("anonymizeName masks a two-part name", () => {
  assert.equal(anonymizeName("Jean Dupont"), "Jean D*****");
});

test("anonymizeName masks a single-word name", () => {
  assert.equal(anonymizeName("Madonna"), "M*****");
});

test("anonymizeName escapes markdown injected via the supporter name", () => {
  // Regression test for point #2: a name crafted to look like a Markdown
  // link must not alter README formatting once inserted. Uses a hyphen
  // instead of a space inside the brackets so the malicious markup stays
  // in a single whitespace-split token (anonymizeName splits on \s+).
  const result = anonymizeName("[Clic-ici](http://evil.example) Dupont");
  assert.equal(result, "\\[Clic\\-ici\\]\\(http://evil\\.example\\) D*****");
});

test("anonymizeName falls back to Anonymous for empty or missing input", () => {
  assert.equal(anonymizeName(""), "Anonymous");
  assert.equal(anonymizeName("   "), "Anonymous");
  assert.equal(anonymizeName(null), "Anonymous");
  assert.equal(anonymizeName(undefined), "Anonymous");
});

test("repoFromReferer resolves a known repo from the path", () => {
  assert.equal(
    repoFromReferer("https://github.com/cyclope205/suivi-stock-pellet"),
    "suivi-stock-pellet"
  );
});

test("repoFromReferer resolves from an explicit ?repo= query param", () => {
  assert.equal(
    repoFromReferer("https://buymeacoffee.com/cyclope205?repo=recettes-express"),
    "recettes-express"
  );
});

test("repoFromReferer returns null for an unknown repo or bad input", () => {
  assert.equal(repoFromReferer("https://github.com/cyclope205/not-a-real-repo"), null);
  assert.equal(repoFromReferer(""), null);
  assert.equal(repoFromReferer(undefined), null);
  assert.equal(repoFromReferer("not a url at all"), null);
});

// ---------------------------------------------------------------------
// buildReadmeUpdate (README merge logic, point #2 and the data half of #4)
// ---------------------------------------------------------------------

test("buildReadmeUpdate creates the donor section when none exists yet", () => {
  const { updated, changed } = buildReadmeUpdate(
    "# Repo\n\n## Licence\nMIT\n",
    { amount: 5, currency: "EUR", supporter_name: "Jean Dupont", created_at: "2026-10-16T10:00:00Z" },
    null,
    "evt_1"
  );
  assert.equal(changed, true);
  assert.match(updated, /START_SECTION:buy-me-a-coffee/);
  assert.match(updated, /Jean D\*\*\*\*\*/);
  assert.match(updated, /#evt_1/);
});

test("buildReadmeUpdate appends a new entry to an existing section", () => {
  const first = buildReadmeUpdate(
    "# Repo\n\n## Licence\nMIT\n",
    { amount: 5, currency: "EUR", supporter_name: "Jean Dupont" },
    null,
    "evt_1"
  );
  const second = buildReadmeUpdate(
    first.updated,
    { amount: 3, currency: "EUR", supporter_name: "Marie Curie" },
    null,
    "evt_2"
  );
  assert.equal(second.changed, true);
  assert.match(second.updated, /#evt_1/);
  assert.match(second.updated, /#evt_2/);
});

test("hasEventId does not false-positive-match a longer id sharing the same prefix (P3)", () => {
  // Regression test: evt_1 must not be reported as already-present just
  // because evt_10's entry contains the substring "#evt_1".
  assert.equal(hasEventId("... #evt_10 ...", "evt_1"), false);
  assert.equal(hasEventId("... #evt_1 ...", "evt_1"), true);
  assert.equal(hasEventId("... #evt_1-retry ...", "evt_1"), false);
  assert.equal(hasEventId("", "evt_1"), false);
  assert.equal(hasEventId("anything", ""), false);
});

test("buildReadmeUpdate treats evt_1 and evt_10 as distinct donations (P3)", () => {
  const withEvt10 = buildReadmeUpdate(
    "# Repo\n\n## Licence\nMIT\n",
    { amount: 5, currency: "EUR", supporter_name: "Jean Dupont" },
    null,
    "evt_10"
  );
  const second = buildReadmeUpdate(
    withEvt10.updated,
    { amount: 3, currency: "EUR", supporter_name: "Marie Curie" },
    null,
    "evt_1"
  );
  // Before the fix this was wrongly treated as a duplicate (changed: false)
  // because "#evt_1" is a substring of "#evt_10".
  assert.equal(second.changed, true);
  assert.match(second.updated, /#evt_10/);
  assert.match(second.updated, /#evt_1(?!\d)/);
});

test("buildReadmeUpdate is idempotent for a duplicate event id (dedup)", () => {
  const first = buildReadmeUpdate(
    "# Repo\n\n## Licence\nMIT\n",
    { amount: 5, currency: "EUR", supporter_name: "Jean Dupont" },
    null,
    "evt_1"
  );
  const second = buildReadmeUpdate(
    first.updated,
    { amount: 5, currency: "EUR", supporter_name: "Jean Dupont" },
    null,
    "evt_1"
  );
  assert.equal(second.changed, false);
  assert.equal(second.updated, first.updated);
});

// ---------------------------------------------------------------------
// updateReadme: retry on a stale sha (point #4)
// ---------------------------------------------------------------------

test("updateReadme retries after a 409 (stale sha) and succeeds on the second attempt", async () => {
  const readmeB64 = Buffer.from("# Repo\n\n## Licence\nMIT\n", "utf8").toString("base64");
  let getCalls = 0;
  let putCalls = 0;

  const restore = mockFetchQueue([
    async () => { getCalls += 1; return { ok: true, json: async () => ({ content: readmeB64, sha: "sha-1" }) }; },
    async () => { putCalls += 1; return { ok: false, status: 409, text: async () => "conflict" }; },
    async () => { getCalls += 1; return { ok: true, json: async () => ({ content: readmeB64, sha: "sha-2" }) }; },
    async () => { putCalls += 1; return { ok: true, json: async () => ({}) }; },
  ]);

  try {
    await withEnv({ GITHUB_TOKEN: "ghp_test" }, async () => {
      const result = await updateReadme(
        "changelog-traduction",
        { amount: 3, currency: "EUR", supporter_name: "Marie Curie" },
        null,
        "evt_retry"
      );
      assert.equal(result.updated, true);
    });
  } finally {
    restore();
  }

  assert.equal(getCalls, 2, "expected a fresh GET (fresh sha) after the 409");
  assert.equal(putCalls, 2, "expected the PUT to be retried once");
});

test("updateReadme gives up after exhausting its retry budget on repeated 409s", async () => {
  const readmeB64 = Buffer.from("# Repo\n\n## Licence\nMIT\n", "utf8").toString("base64");
  const restore = mockFetchQueue([
    async () => ({ ok: true, json: async () => ({ content: readmeB64, sha: "sha-x" }) }),
    async () => ({ ok: false, status: 409, text: async () => "conflict" }),
  ]);

  try {
    await withEnv({ GITHUB_TOKEN: "ghp_test" }, async () => {
      await assert.rejects(
        () => updateReadme("changelog-traduction", { amount: 1, supporter_name: "X Y" }, null, "evt_fail"),
        /409/
      );
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------
// Full handler (signature, size limit, routing)
// ---------------------------------------------------------------------

test("handler rejects non-POST requests", async () => {
  const req = makeReq({ method: "GET" });
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test("handler returns 500 when BMC_WEBHOOK_SECRET is not configured", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: "" }, async () => {
    const req = makeReq({ chunks: ["{}"] });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
  });
});

test("handler rejects an invalid signature", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET }, async () => {
    const body = JSON.stringify({ type: "donation.created" });
    const req = makeReq({
      headers: { "x-signature-sha256": "0".repeat(64) },
      chunks: [body],
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  });
});

test("handler ignores a non-donation event even with a valid signature", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET }, async () => {
    const body = JSON.stringify({ type: "donation.refunded", event_id: "evt_x" });
    const req = makeReq({
      headers: { "x-signature-sha256": sign(body) },
      chunks: [body],
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ignored, true);
  });
});

test("handler rejects invalid JSON after a valid-looking body", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET }, async () => {
    const body = "not json";
    const req = makeReq({
      headers: { "x-signature-sha256": sign(body) },
      chunks: [body],
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500); // JSON.parse throws -> caught by the generic handler
  });
});

test("handler rejects a body over MAX_BODY_BYTES before touching the signature (point #1)", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET }, async () => {
    const bigChunk = "a".repeat(MAX_BODY_BYTES + 1024);
    const req = makeReq({
      headers: { "x-signature-sha256": "irrelevant" },
      chunks: [bigChunk],
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 413);
  });
});

test("handler pauses the request instead of destroying it on oversize (P2b)", async () => {
  // Regression test: destroy()-ing the request can tear down the
  // underlying socket before the 413 response is written. Pausing keeps
  // the connection alive so the response actually reaches the client —
  // asserting statusCode 413 above only proves our own code *thinks* it
  // responded; this asserts we no longer use the method that could kill
  // the connection before that response is sent.
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET }, async () => {
    const bigChunk = "a".repeat(MAX_BODY_BYTES + 1024);
    const req = makeReq({
      headers: { "x-signature-sha256": "irrelevant" },
      chunks: [bigChunk],
    });
    let destroyed = false;
    let paused = false;
    req.destroy = () => { destroyed = true; };
    req.pause = () => { paused = true; };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 413);
    assert.equal(paused, true, "expected req.pause() to be called");
    assert.equal(destroyed, false, "expected req.destroy() NOT to be called");
  });
});

test("real HTTP client receives 413 for an oversized webhook body (P2b)", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET }, async () => {
    const server = http.createServer((req, res) => {
      // Adapt Node's real ServerResponse to the small status().json() API
      // used by the Vercel handler, while preserving real socket behavior.
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (payload) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
        return res;
      };
      handler(req, res);
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const body = Buffer.alloc(MAX_BODY_BYTES + 1024, 0x61);
      const response = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: server.address().port,
          path: "/api/webhook",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
            "x-signature-sha256": "irrelevant",
            connection: "close",
          },
        }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        req.setTimeout(5000, () => req.destroy(new Error("Timed out waiting for HTTP 413")));
        req.once("error", reject);
        req.end(body);
      });

      assert.equal(response.statusCode, 413);
      assert.deepEqual(JSON.parse(response.body), { error: "Payload too large" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("handler attributes a donation end-to-end and updates the README", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN: "ghp_test", BMC_API_TOKEN: "bmc_test" }, async () => {
    const event = {
      type: "donation.created",
      event_id: "evt_e2e",
      data: {
        supporter_id: "sup_1",
        amount: 5,
        currency: "EUR",
        supporter_name: "Ada Lovelace",
      },
    };
    const body = JSON.stringify(event);
    const readmeB64 = Buffer.from("# Repo\n\n## Licence\nMIT\n", "utf8").toString("base64");

    const restore = mockFetchQueue([
      // bmcGetSupporter
      async () => ({ ok: true, json: async () => ({ data: { referer: "https://github.com/cyclope205/changelog-traduction" } }) }),
      // updateReadme GET
      async () => ({ ok: true, json: async () => ({ content: readmeB64, sha: "sha-1" }) }),
      // updateReadme PUT
      async () => ({ ok: true, json: async () => ({}) }),
    ]);

    try {
      const req = makeReq({
        headers: { "x-signature-sha256": sign(body) },
        chunks: [body],
      });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.attributed, true);
      assert.equal(res.body.repository, "changelog-traduction");
      assert.equal(res.body.updated, true);
    } finally {
      restore();
    }
  });
});

test("handler reports attributed:false when no repo can be resolved from the referer", async () => {
  await withEnv({ BMC_WEBHOOK_SECRET: SECRET, BMC_API_TOKEN: "bmc_test" }, async () => {
    const event = {
      type: "donation.created",
      event_id: "evt_unattrib",
      data: { supporter_id: "sup_2", amount: 2, supporter_name: "X Y" },
    };
    const body = JSON.stringify(event);

    const restore = mockFetchQueue([
      async () => ({ ok: true, json: async () => ({ data: { referer: "https://buymeacoffee.com/cyclope205" } }) }),
    ]);

    try {
      const req = makeReq({
        headers: { "x-signature-sha256": sign(body) },
        chunks: [body],
      });
      const res = makeRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.attributed, false);
    } finally {
      restore();
    }
  });
});
