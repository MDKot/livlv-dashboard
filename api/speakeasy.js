const TOKENS = {
  lv: "9QRm0GFvcZ3GjGUzdlpJCP9vEtB/51xMGPiRV5V1ldFIPJDWe75UP3M9MR80+5ps0Z1kuHmEGzxNyTwZIzFjJkg0PxPZrWCKTJeNuSuONcyMk6b2zjU6WwdMqSbIRRuey750CZzjyYbh0bDOcxwnyw==",
  bc: "9QRm0GFvcZ3GjGUzdlpJCP9vEtB/51xMGPiRV5V1ldFIPJDWe75UP3M9MR80+5psbnKfbZ3pjdt8RwQ2zqHh7L6UsnDquR5aMF+ZedUuYwAnGIlHWYvFtGTdwp11Amm/M0fX1ELGh6/Y7x3Tp2duQw==",
};

const ENDPOINTS = {
  events:     "https://production.speakeasygo.com/partners/events?skip=0&take=200&orderBy=startDateTime%7Casc&version=PUBLISHED&eventStatus=APPROVED&status=ENABLED&timeVersion=UPCOMING&isDiscounted=false",
  statistics: "https://production.speakeasygo.com/partners/events/statistics?skip=0&take=200",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { account, endpoint } = req.query;
  const token = TOKENS[account];
  const url   = ENDPOINTS[endpoint];

  if (!token || !url) return res.status(400).json({ error: "Invalid account or endpoint" });

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        "token": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "LIV-Dashboard/1.0",
      },
    });

    const text = await upstream.text();
    console.log(`[Proxy] ${account}/${endpoint} → ${upstream.status}: ${text.slice(0, 200)}`);

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Upstream error",
        status: upstream.status,
        body: text,
      });
    }

    res.status(200).json(JSON.parse(text));
  } catch (err) {
    console.error("[Proxy] Error:", err);
    res.status(500).json({ error: err.message });
  }
}
