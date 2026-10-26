/**
 * Worker thread for `htmlToMarkdown` on large pages (see pipeline.mjs
 * `convertHtml`). Converting a multi-megabyte page is seconds to minutes of
 * synchronous work; on the main thread it stalls every other page in flight and
 * the timers that keep this process's cross-process locks fresh.
 *
 * workerData: { module: <URL of a conversion-interface module>, args: {url, finalUrl, html, siblings} }
 */

import { parentPort, workerData } from 'node:worker_threads';

try {
  const mod = await import(workerData.module);
  const convert = mod.default ?? mod;
  const out = await convert.htmlToMarkdown(workerData.args);
  const result = typeof out === 'string' ? { markdown: out, title: null } : { markdown: out?.markdown ?? '', title: out?.title ?? null };
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.message || err) });
}
