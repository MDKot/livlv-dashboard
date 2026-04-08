// Vercel serverless proxy for Speakeasy API
// Runs server-side so the token header never exposes a CORS issue

const SPK_BASE = "https://production.speakeasygo.com/partners";

const TOKENS = {
  lv: "9QRm0GFvcZ3GjGUzdlpJCP9vEtB/51xMGPiRV5V1ldFIPJDWe75UP3M9MR80+5ps0Z1kuHmEGzxNyTwZIzFjJkg0PxPZrWCKTJeNuSuONcyMk6b2zjU6WwdMqSbIRRuey750CZzjyYbh0bDOcxwnyw==",
  bc: "9QRm0GFvcZ3GjGUzdlpJCP9vEtB/51xMGPiRV5V1ldFIPJDWe75UP3M9MR80+5psbnKfbZ3pjdt8RwQ2zqHh7L6UsnDquR5aMF+ZedUuYwAnGIlHWYvFtGTdwp11Amm/M0fX1ELGh6/Y7x3Tp2duQw==",
};

export default async function handler(req, res) {
  // CORS — allow requests from the dashboard domain
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { account, endpoint } = req.query;
  // account: "lv" or "bc"
  // endpoint: "events" or "statistics"

  const token = TOKENS[account];
  if (!token) return res.status(400).json({ error: "Invalid account" });

  let url;
  if (endpoint === "events") {
    url = `${SPK_BASE}/events?skip=0&take=200&orderBy=startDateTime%7Casc&version=PUBLISHED&eventStatus=APPROVED&status=ENABLED&timeVersion=UPCOMING&isDiscounted=false`;
  } else if (endpoint === "statistics") {
    url = `${SPK_BASE}/events/statistics?skip=0&take=200`;
  } else {
    return res.status(400).json({ error: "Invalid endpoint" });
  }

  try {
    const upstream = await fetch(url, { headers: { token } });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Speakeasy proxy error:", err);
    res.status(500).json({ error: "Proxy error", detail: err.message });
  }
}
