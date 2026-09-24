const REPOSITORIES = new Set([
  "changelog-traduction",
  "suivi-stock-pellet",
  "programme-tnt-fr",
  "recettes-express",
]);

module.exports = function handler(req, res) {
  const repo = String(req.query?.repo || "");
  if (!REPOSITORIES.has(repo)) {
    return res.status(400).send("Invalid repository");
  }

  res.setHeader("Referrer-Policy", "unsafe-url");
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, `https://buymeacoffee.com/cyclope205?repo=${encodeURIComponent(repo)}`);
};
