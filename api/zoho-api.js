export default async function handler(req, res) {
  const path = req.url.replace(/^\/api\/zoho-api/, '') || '/';
  const targetUrl = `https://campaigns.zoho.com/api/v1.1${path}`;

  console.log('[zoho-api] fetching:', targetUrl); // ← debug

  const response = await fetch(targetUrl, {
    headers: {
      Authorization: req.headers.authorization,
    },
  });

  const text = await response.text();
  console.log('[zoho-api] status:', response.status, text.slice(0, 200)); // ← debug

  try {
    res.status(response.status).json(JSON.parse(text));
  } catch {
    res.status(500).json({ error: 'Non-JSON response from Zoho', raw: text });
  }
}