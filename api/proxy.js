// Vercel serverless proxy for Romanian public APIs.
//   GET  /api/proxy?url=<urlencoded>          → proxies GET (data.gov.ro)
//   POST /api/proxy?url=<urlencoded>  + body  → proxies POST (ANAF)

const ALLOWED_HOSTS = ["webservicesp.anaf.ro", "data.gov.ro"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url=" });

  let host;
  try { host = new URL(target).host; }
  catch { return res.status(400).json({ error: "Bad URL" }); }
  if (!ALLOWED_HOSTS.includes(host)) {
    return res.status(403).json({ error: `Host not allowed: ${host}` });
  }

  // Build the upstream request differently for GET vs POST
  const fetchOpts = {
    method: req.method,
    headers: {
      // Pretend to be a normal browser — some Romanian gov hosts reject
      // requests with no User-Agent or unusual ones.
      "User-Agent": "Mozilla/5.0 (compatible; ro-public-data/1.0)",
      "Accept": "application/json",
    },
  };
  if (req.method === "POST") {
    fetchOpts.headers["Content-Type"] = "application/json";
    // req.body comes in pre-parsed by Vercel — re-stringify it
    fetchOpts.body = typeof req.body === "string"
      ? req.body
      : JSON.stringify(req.body);
  }

  try {
    console.log("→ upstream", req.method, target);
    const upstream = await fetch(target, {
      ...fetchOpts,
      signal: AbortSignal.timeout(25000),
    });
    const text = await upstream.text();
    console.log("← upstream", upstream.status, "(", text.length, "bytes)");

    res.status(upstream.status);
    res.setHeader("Content-Type",
      upstream.headers.get("content-type") || "application/json");
    if (upstream.ok) {
      res.setHeader("Cache-Control",
        "s-maxage=3600, stale-while-revalidate=86400");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }
    res.send(text);
  } catch (e) {
    console.error("PROXY ERROR:", e);
    res.status(502).json({
      error: "Upstream fetch failed",
      message: e.message,
      cause: String(e.cause || ""),
      target,
    });
  }
}
