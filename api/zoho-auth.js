export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Collect body chunks — works in both Vite dev and Vercel prod
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });

  console.log('[zoho-auth] body:', body); // ← debug: check terminal

  const response = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await response.text(); // read as text first
  console.log('[zoho-auth] zoho response:', response.status, text); // ← debug

  try {
    res.status(response.status).json(JSON.parse(text));
  } catch {
    res.status(500).json({ error: 'Non-JSON response from Zoho', raw: text });
  }
}