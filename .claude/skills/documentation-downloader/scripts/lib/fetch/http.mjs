/**
 * Plain HTTP for the fetch pipeline: one GET, politely.
 *
 *   const http = createHttp();                 // or pass your own `fetch`
 *   const res = await http.get(url, { accept: 'text/html', timeoutMs: 15000 });
 *   // → { status, url /* final, after HTTP redirects *\/, headers, contentType, text, bytes, ms }
 *
 * - Politeness: every request runs inside the store's machine-wide `withHostSlot`
 *   (N in flight per host, minimum gap between starts), shared with every other
 *   docs process on the machine.
 * - Retries: transient network errors, 408/429/5xx-gateway statuses, bounded.
 *   A 429/503 `Retry-After` is honoured (seconds or HTTP date) up to a cap; a
 *   longer demand is not waited out — the response is returned as is.
 * - HTTP status is data, not an exception: a 404 returns `{status: 404}`. Only a
 *   request that never produced a response throws (HttpError, `code` set).
 *
 * Injectable: anything with the same `get(url, opts)` shape can stand in for
 * `createHttp()` (the replay eval serves recorded snapshots this way), and
 * `createHttp({ fetch })` swaps just the transport under the retry/politeness logic.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { withHostSlot } from '../store/limits.mjs';

/**
 * Requests look like a current desktop Chrome navigation: its user agent AND the
 * headers Chrome sends with it. Some hosts serve bots a stripped page; others refuse
 * a request that claims to be Chrome without Chrome's other headers
 * (developers.facebook.com: HTTP 400 for every page and its `.md` twin).
 * Renders use the launched browser's own version (render.mjs, chromeUserAgent).
 */
export const CHROME_MAJOR = 154;
export function chromeUserAgent(major = CHROME_MAJOR) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
export const USER_AGENT = chromeUserAgent();
/** The headers Chrome sends with a top-level navigation (Accept is per request). */
export function chromeHeaders(ua = USER_AGENT) {
  const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? String(CHROME_MAJOR);
  return {
    'User-Agent': ua,
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not A(Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    Priority: 'u=0, i',
  };
}

export const ACCEPT = {
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  markdown: 'text/markdown, text/x-markdown;q=0.9, text/plain;q=0.5',
  text: 'text/plain, text/markdown;q=0.9, */*;q=0.5',
  xml: 'application/xml, text/xml;q=0.9, */*;q=0.5',
};

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ERR_TOO_MANY_RETRIES/;

export class HttpError extends Error {
  constructor(message, { url, code, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.url = url;
    this.code = code || 'EHTTP';
    if (cause) this.cause = cause;
  }
}

/** Parse Retry-After (delta-seconds or HTTP-date) into ms; null when absent/garbage. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

function decode(bytes, contentType) {
  const m = /charset=["']?([\w.:-]+)/i.exec(contentType || '');
  if (m) {
    try { return new TextDecoder(m[1].toLowerCase()).decode(bytes); } catch { /* unknown label */ }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function isTransient(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  const text = `${err.code || ''} ${err.message || ''} ${err.cause?.code || ''} ${err.cause?.message || ''}`;
  return TRANSIENT_CODES.test(text) || /fetch failed|socket hang up|other side closed/i.test(text);
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch]    transport (default: global fetch)
 * @param {boolean} [opts.polite=true]   wrap requests in the machine-wide host slot
 * @param {number} [opts.hostIntervalMs] override the host's average gap between request starts
 * @param {number} [opts.hostBurst]      override how many requests to a host may start together
 * @param {number} [opts.retries=2]      extra attempts for transient failures
 * @param {number} [opts.maxRetryAfterMs=20000]  longest Retry-After we will wait
 * @param {string} [opts.userAgent]
 * @param {(ms: number) => Promise<void>} [opts.sleep]  for tests
 */
export function createHttp(opts = {}) {
  const transport = opts.fetch ?? globalThis.fetch;
  const polite = opts.polite ?? true;
  const defaultRetries = opts.retries ?? 2;
  const maxRetryAfter = opts.maxRetryAfterMs ?? 20_000;
  const ua = opts.userAgent ?? USER_AGENT;
  const wait = opts.sleep ?? ((ms) => sleep(ms));
  const slotOpts = {
    ...(opts.hostIntervalMs != null ? { intervalMs: opts.hostIntervalMs } : {}),
    ...(opts.hostBurst != null ? { burst: opts.hostBurst } : {}),
  };

  const browserHeaders = chromeHeaders(ua);

  async function once(url, req) {
    const { accept, timeoutMs, signal, headers, want } = req;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const t0 = Date.now();
    const res = await transport(url, {
      method: 'GET',
      redirect: 'follow',
      signal: combined,
      headers: {
        ...browserHeaders,
        Accept: accept,
        ...headers,
      },
    });
    const contentType = res.headers.get('content-type') || '';
    if (want && !want({ status: res.status, contentType, url: res.url || url })) {
      // Not what the caller is looking for (e.g. HTML from a server that ignored
      // Accept: text/markdown): don't download a body nobody will read.
      await res.body?.cancel().catch(() => {});
      return {
        status: res.status, url: res.url || url, headers: Object.fromEntries(res.headers.entries()),
        contentType, bytes: Buffer.alloc(0), text: '', skipped: true, ms: Date.now() - t0,
      };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      url: res.url || url,
      headers: Object.fromEntries(res.headers.entries()),
      contentType,
      bytes,
      text: decode(bytes, contentType),
      ms: Date.now() - t0,
    };
  }

  /**
   * GET a URL.
   * @param {string} url
   * @param {{accept?: string, timeoutMs?: number, signal?: AbortSignal, retries?: number, headers?: object,
   *          want?: (head: {status: number, contentType: string, url: string}) => boolean}} [o]
   *   `want`: decide from status + headers whether the body is worth downloading;
   *   when it returns false the result has `skipped: true` and an empty body.
   */
  async function get(url, o = {}) {
    const req = {
      accept: o.accept ?? ACCEPT.html,
      timeoutMs: o.timeoutMs ?? 20_000,
      signal: o.signal,
      headers: o.headers,
      want: o.want,
    };
    const retries = o.retries ?? defaultRetries;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (o.signal?.aborted) throw new HttpError(`aborted: ${url}`, { url, code: 'EABORT' });
      let res;
      try {
        res = polite ? await withHostSlot(url, () => once(url, req), slotOpts) : await once(url, req);
      } catch (err) {
        if (o.signal?.aborted) throw new HttpError(`aborted: ${url}`, { url, code: 'EABORT', cause: err });
        lastErr = err;
        if (attempt < retries && isTransient(err)) {
          await wait(500 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        const timedOut = err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message);
        throw new HttpError(timedOut ? `timed out after ${req.timeoutMs} ms: ${url}` : `${err.cause?.code || err.message}: ${url}`,
          { url, code: timedOut ? 'ETIMEOUT' : (err.cause?.code || err.code || 'ENET'), cause: err });
      }
      if (attempt < retries && RETRY_STATUS.has(res.status)) {
        const ra = retryAfterMs(res.headers['retry-after']);
        if (ra !== null && ra > maxRetryAfter) return res; // not waiting that long
        await wait(ra ?? 750 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      return res;
    }
    throw lastErr; // unreachable: the loop returns or throws
  }

  return { get };
}

let shared = null;

/** GET with the default client (global fetch, polite, retries). Same result shape as `createHttp().get`. */
export function httpGet(url, opts) {
  shared ??= createHttp();
  return shared.get(url, opts);
}
