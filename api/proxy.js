// Vercel serverless proxy for Romanian public APIs.
// Routes:
//   GET  /api/proxy?url=<urlencoded>           → proxies GET (data.gov.ro)
//   POST /api/proxy?url=<urlencoded>  + body   → proxies POST (ANAF)

const ALLOWED_HOSTS = [
  "webservicesp.anaf.ro",
  "data.gov.ro",
];

export default async function handler(req, res) {
  // CORS — allow your own site (and dev) to call this proxy
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url=" });

  // Whitelist guard — never let this proxy be used as an open relay
  let host;
  try { host = new URL(target).host; }
  catch { return res.status(400).json({ error: "Bad URL" }); }
  if (!ALLOWED_HOSTS.includes(host)) {
    return res.status(403).json({ error: `Host not allowed: ${host}` });
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "Upstream fetch failed: " + e.message });
  }
}
