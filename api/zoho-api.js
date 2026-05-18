export default async function handler(req, res) {
  // Full URL including query string after /api/zoho-api
  const url = new URL(req.url, 'http://localhost');
  
  // Strip /api/zoho-api from the beginning to get the endpoint path
  const endpoint = url.pathname.replace(/^\/api\/zoho-api/, '') || '/';
  
  // Forward all query params
  const targetUrl = new URL(`https://campaigns.zoho.com/api/v1.1${endpoint}`);
  url.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

  console.log('[zoho-api] fetching:', targetUrl.toString());

  const response = await fetch(targetUrl.toString(), {
    headers: {
      Authorization: req.headers.authorization,
    },
  });

  const text = await response.text();
  console.log('[zoho-api] status:', response.status, text.slice(0, 200));

  try {
    res.status(response.status).json(JSON.parse(text));
  } catch {
    res.status(500).json({ error: 'Non-JSON response from Zoho', raw: text });
  }
}