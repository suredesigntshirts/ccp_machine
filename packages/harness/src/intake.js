// The request box: the person files work from mission control (an Artifact `db` collection, `requests`),
// and on each tick the host hands the new rows here. Each row becomes REQUEST_RECEIVED with id
// `req-<row id>`, so a row read twice files one item; the returned updates mark the rows taken.
import { apply } from './runtime.js';
import { itemHref } from './page.js';

export const REQUESTS = 'requests';

/** Rows from an ArtifactData list or query result, a bare array, or {docs|documents|items|rows: [...]}. */
export function rowsOf(result) {
  const list = Array.isArray(result) ? result : (result?.docs ?? result?.documents ?? result?.items ?? result?.rows ?? []);
  return list.map((r) => {
    const data = r.data && typeof r.data === 'object' ? r.data : r;
    const id = String(r.id ?? r.doc_id ?? r.path?.split('/').at(-1) ?? data.id ?? '');
    return { ...data, id };
  });
}

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 4)
    .join('-') || 'request';

/** The item a row files: tier 0 to 2 (anything else is 1, which asks the stand-in at the plan gate). */
export function requestFor(row) {
  const tier = [0, 1, 2].includes(Number(row.tier)) && row.tier !== '' && row.tier != null ? Number(row.tier) : 1;
  const id = `ask-${slug(row.title)}-${row.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)}`;
  const request = { id, title: String(row.title ?? '').slice(0, 200) || id, tier, source: `request-box:${row.id}` };
  if (row.project) request.project = String(row.project).slice(0, 100);
  if (row.done) request.expect = String(row.done).slice(0, 1000);
  return request;
}

/**
 * File every row whose status is `new` (or missing). Returns the rows filed, the rows skipped and, for
 * the host to write back with ArtifactData, one update per filed row: {doc_id, data: {status, item, href}}.
 */
export function intakeRows(store, result, { at = new Date().toISOString() } = {}) {
  const filed = [];
  const skipped = [];
  const updates = [];
  for (const row of rowsOf(result)) {
    if (!row.id || !row.title || (row.status && row.status !== 'new')) {
      skipped.push({ id: row.id, why: !row.id ? 'no id' : !row.title ? 'no title' : `status ${row.status}` });
      continue;
    }
    const request = requestFor(row);
    const r = apply(store, { type: 'REQUEST_RECEIVED', request, person: true }, { id: `req-${row.id}` });
    filed.push({ row: row.id, item: request.id, duplicate: r.duplicate === true });
    updates.push({ doc_id: row.id, data: { status: 'taken', item: request.id, href: itemHref(request.id), takenAt: at } });
  }
  return { filed, skipped, updates };
}
