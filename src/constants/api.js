// Shared Zoho helpers. Both the Campaigns dashboard and the Lists panel import from here,
// so there is one token cache instead of two.

const ZOHO_CONFIG = {
  CLIENT_ID: import.meta.env.ZOHO_CLIENT_ID || "",
  CLIENT_SECRET: import.meta.env.ZOHO_CLIENT_SECRET || "",
  TOKEN_URL: "/api/zoho-auth",
  API_BASE: "/api/zoho-api", // leading slash added: the path must resolve from the site root
  REFRESH_TOKEN: import.meta.env.ZOHO_REFRESH_TOKEN || "",
  BEARER_TOKEN: import.meta.env.ZOHO_BEARER_TOKEN || "",
};

let cachedToken = null;
let tokenExpiry = 0;
let tokenPromise = null; // prevents parallel requests from each triggering a refresh

async function refreshAccessToken() {
  const body = new URLSearchParams({
    client_id: ZOHO_CONFIG.CLIENT_ID,
    client_secret: ZOHO_CONFIG.CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: ZOHO_CONFIG.REFRESH_TOKEN,
  });
  const res = await fetch(ZOHO_CONFIG.TOKEN_URL, { method: "POST", body });
  const data = await res.json();
  if (data.access_token) {
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return cachedToken;
  }
  return null;
}

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (ZOHO_CONFIG.REFRESH_TOKEN) {
    tokenPromise = tokenPromise || refreshAccessToken().finally(() => (tokenPromise = null));
    const t = await tokenPromise;
    if (t) return t;
  }
  return ZOHO_CONFIG.BEARER_TOKEN;
}

export async function zohoFetch(path, params = {}, signal) {
  const token = await getAccessToken();
  const url = new URL(`${ZOHO_CONFIG.API_BASE}${path}`, window.location.origin);
  url.searchParams.set("resfmt", "JSON");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    signal,
  });
  if (!res.ok) throw new Error(`Zoho API ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Walks a paginated Zoho endpoint (fromindex is 1-based, range is the page size)
 * until a short page comes back or maxRows is reached.
 *
 * extract(data) must return the array of rows from one response.
 * onProgress(rowsSoFar) is called after every page.
 */
export async function zohoFetchAll(
  path,
  params,
  { extract, pageSize = 200, maxRows = 20000, onProgress, signal } = {}
) {
  const rows = [];
  let fromindex = 1;
  while (rows.length < maxRows) {
    let page;
    try {
      const data = await zohoFetch(
        path,
        { ...params, fromindex, range: pageSize },
        signal
      );
      page = extract(data);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      // Past the last page Zoho may answer with an error; keep what we have.
      if (rows.length > 0) break;
      throw e;
    }
    if (!page.length) break;
    rows.push(...page);
    onProgress?.(rows.length);
    if (page.length < pageSize) break;
    fromindex += page.length;
  }
  return rows;
}