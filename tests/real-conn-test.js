// Run with: node tests/real-conn-test.js
//
// Verifie, sur une VRAIE connexion TCP (pas un req/res simule comme dans
// webhook.test.js), que le client recoit bien le statut 413 quand il
// envoie un corps trop volumineux au webhook, au lieu que la connexion
// soit simplement coupee (ECONNRESET) avant que la reponse n'ait eu le
// temps de partir.
//
// Complement e2e a "handler pauses the request instead of destroying it
// on oversize (P2b)" dans webhook.test.js : ce test-la prouve que notre
// code appelle req.pause() plutot que req.destroy(), mais seulement sur
// un req/res simule — il ne prouve pas que le client recoit vraiment la
// reponse HTTP sur une socket reelle. Ce script le verifie de bout en
// bout avec un vrai http.createServer + une vraie requete HTTP.
//
// Contrairement a webhook.test.js, ce script n'utilise pas node:test —
// il pilote directement un serveur/client HTTP reel et determine
// lui-meme son code de sortie (0 = succes, 1 = echec), pour que node
// tests/real-conn-test.js fasse echouer le pipeline CI comme n'importe
// quel autre test en cas de regression.

const http = require("http");
const handler = require("../api/webhook.js");

process.env.BMC_WEBHOOK_SECRET = "test-secret-for-real-conn-check";

// api/webhook.js attend l'API style Vercel (res.status().json()), que
// Node's http.ServerResponse brut ne fournit pas. On ajoute un petit shim
// minimal pour reproduire fidelement ce que Vercel donne au handler en prod.
function withVercelShim(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (payload) {
    const body = JSON.stringify(payload);
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(body);
    return res;
  };
  return res;
}

const server = http.createServer((req, res) => {
  withVercelShim(res);
  handler(req, res).catch((err) => {
    console.error("Unhandled handler error:", err);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

function log(line) {
  console.log(line);
}

function runTest() {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      log(`Serveur de test demarre sur 127.0.0.1:${port}`);

      const totalBytes = handler._internal.MAX_BODY_BYTES + 50 * 1024; // 50 KB au-dessus de la limite
      const chunkSize = 8 * 1024; // on envoie par petits paquets pour simuler un vrai flux reseau
      let sent = 0;

      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/webhook",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(totalBytes),
            "x-signature-sha256": "0".repeat(64), // signature invalide, mais on ne doit meme pas l'atteindre
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            log(`RESULTAT: le client a recu le statut HTTP ${res.statusCode}`);
            log(`RESULTAT: corps de reponse = ${body}`);
            resolve({ ok: true, statusCode: res.statusCode, body });
          });
        }
      );

      req.on("error", (err) => {
        log(`RESULTAT: le client a recu une ERREUR reseau au lieu d'une reponse HTTP: ${err.code || err.message}`);
        resolve({ ok: false, error: err.code || err.message });
      });

      function sendChunk() {
        if (req.destroyed || req.writableEnded) return;
        const remaining = totalBytes - sent;
        if (remaining <= 0) {
          req.end();
          return;
        }
        const size = Math.min(chunkSize, remaining);
        const chunk = Buffer.alloc(size, "a");
        sent += size;
        const canContinue = req.write(chunk);
        if (canContinue) {
          setImmediate(sendChunk);
        } else {
          req.once("drain", sendChunk);
        }
      }

      sendChunk();
    });
  });
}

runTest().then((result) => {
  server.close();
  log("");
  if (result.ok && result.statusCode === 413) {
    log("VERDICT: OK - le client recoit bien un vrai 413 sur une connexion reelle.");
    process.exitCode = 0;
  } else if (result.ok) {
    log(`VERDICT: ECHEC - statut inattendu (${result.statusCode}), pas de 413 propre.`);
    process.exitCode = 1;
  } else {
    log(`VERDICT: ECHEC - la connexion a ete coupee avant la reponse (${result.error}), le client ne recoit pas de 413 exploitable.`);
    process.exitCode = 1;
  }
  log("DONE");
});
