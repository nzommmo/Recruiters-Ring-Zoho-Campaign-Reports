// Fast loader for the subscribers of one list.
//
// Compared with walking pages one by one:
//   1. Pages are requested in parallel. The page count is worked out from the list's contact
//      count, so there is no waiting for a short page to know when to stop.
//   2. Requests go through a shared limiter, so several lists can load at once without
//      flooding Zoho.
//   3. 429 and 5xx responses are retried with backoff instead of failing the whole load.
//   4. Results are cached at module level, so they survive switching tabs.

import { zohoFetch } from "./api";
import { extractContacts, normContact } from "./ZohoLists";

const MAX_CONCURRENT = 6;          // simultaneous requests across all lists
const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZES = [1000, 200];    // largest first; falls back if Zoho rejects the range

const cache = new Map();           // `${listkey}:${status}` -> { at, contacts }
let sizeIndex = 0;                 // remembers which page size worked

// ── request limiter ──
let active = 0;
const waiting = [];
const acquire = () =>
  active < MAX_CONCURRENT ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r));
const release = () => {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight over
  else active--;
};

const abortError = () => new DOMException("Aborted", "AbortError");
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

// 4xx other than auth and rate limiting: Zoho is saying "no such page" or "bad range".
const isClientError = (e) =>
  e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status);

async function withRetry(fn, signal, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e.status === 429 || e.status >= 500;
      if (e.name === "AbortError" || !retryable || attempt >= retries) throw e;
      await sleep(500 * 2 ** attempt + Math.random() * 250, signal);
    }
  }
}

async function fetchPage(listkey, status, fromindex, range, signal) {
  await acquire();
  try {
    if (signal?.aborted) throw abortError();
    const data = await withRetry(
      () => zohoFetch("/getlistsubscribers", { listkey, status, sort: "asc", fromindex, range }, signal),
      signal
    );
    return extractContacts(data);
  } finally {
    release();
  }
}

export const hasCachedContacts = (listkey, status = "active") => {
  const hit = cache.get(`${listkey}:${status}`);
  return !!hit && Date.now() - hit.at < CACHE_TTL_MS;
};

export const clearContactCache = () => cache.clear();

/**
 * Loads every subscriber of a list with the given status.
 * list: { key, contacts } where contacts is the list's contact count (an upper bound).
 * onProgress(rowsSoFar) fires as pages arrive. Returns de-duplicated, normalised contacts.
 */
export async function loadListContacts(list, { status = "active", signal, onProgress, force = false } = {}) {
  const cacheKey = `${list.key}:${status}`;
  const hit = cache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    onProgress?.(hit.contacts.length);
    return hit.contacts;
  }

  // Cancel sibling requests as soon as one fails or the caller aborts.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const raw = [];
    const add = (page) => { raw.push(...page); onProgress?.(raw.length); };
    const tolerant = (p) => p.catch((e) => { if (isClientError(e)) return []; throw e; });

    // First page doubles as a probe for the biggest page size Zoho accepts.
    let range = PAGE_SIZES[sizeIndex];
    let first;
    for (let i = sizeIndex; i < PAGE_SIZES.length; i++) {
      range = PAGE_SIZES[i];
      const lastOption = i === PAGE_SIZES.length - 1;
      try {
        first = await fetchPage(list.key, status, 1, range, ctrl.signal);
        // An empty answer for a list that should have contacts usually means a rejected range.
        if (!first.length && status === "active" && list.contacts > 0 && !lastOption) continue;
        sizeIndex = i;
        break;
      } catch (e) {
        if (!lastOption && isClientError(e)) continue;
        throw e;
      }
    }
    add(first);

    if (first.length >= range) {
      // Remaining pages are known up front, so fire them all (the limiter paces them).
      const total = Math.max(list.contacts, first.length);
      const extra = Math.max(0, Math.ceil(total / range) - 1);
      const pages = await Promise.all(
        Array.from({ length: extra }, (_, i) =>
          tolerant(fetchPage(list.key, status, 1 + (i + 1) * range, range, ctrl.signal)).then((p) => {
            add(p);
            return p;
          })
        )
      );

      // The contact count can be out of date, so keep going while pages come back full.
      let lastLen = pages.length ? pages[pages.length - 1].length : first.length;
      let next = 1 + (extra + 1) * range;
      while (lastLen >= range) {
        const p = await tolerant(fetchPage(list.key, status, next, range, ctrl.signal));
        add(p);
        lastLen = p.length;
        next += range;
      }
    }

    const seen = new Set();
    const contacts = [];
    for (const r of raw) {
      const c = normContact(r);
      if (!c.email || seen.has(c.email)) continue; // zuid is the account id, so email is the key
      seen.add(c.email);
      contacts.push(c);
    }
    cache.set(cacheKey, { at: Date.now(), contacts });
    return contacts;
  } catch (e) {
    ctrl.abort(); // stop any pages still in flight for this list
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}