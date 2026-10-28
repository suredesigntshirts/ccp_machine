// The one history (epic #59): every era's events in one shape, spec/history.schema.json. This module only
// reads that file: validate() holds a row to it (with the actor and source kinds from harness meta), placeholders()
// counts the legacy values doctor reports, factKey() and dedupe() apply its identity rules, and checkLogNeeds()
// holds a history to a view's needs file. The schema is a subset of JSON Schema, and so is the checker below.
import { readFileSync } from 'node:fs';
import { specs } from './machines.js';

export const HISTORY = JSON.parse(readFileSync(new URL('../spec/history.schema.json', import.meta.url), 'utf8'));
const META = specs.harness.meta;

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isLegacy = (v) => typeOf(v) === 'object' && Object.keys(v).length === 1 && typeof v.legacy === 'string' && v.legacy.length > 0;

// The JSON Schema keywords the history uses: type, enum, required, properties, additionalProperties: false,
// items, minItems, minLength, pattern, minimum, maximum, anyOf and local $ref. Returns problems as "path: what".
function check(schema, v, path, out) {
  if (schema.$ref) return check(schema.$ref.slice(2).split('/').reduce((n, k) => n[k], HISTORY), v, path, out);
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => !check(s, v, path, []).length)) out.push(`${path}: matches none of its forms`);
    return out;
  }
  const t = typeOf(v);
  if (schema.type && ![schema.type].flat().some((s) => s === t || (s === 'number' && t === 'integer'))) return out.push(`${path}: is ${t}, not ${schema.type}`), out;
  if (schema.enum && !schema.enum.includes(v)) out.push(`${path}: ${JSON.stringify(v)} is not one of ${schema.enum.join('|')}`);
  if (t === 'string' && schema.minLength && v.length < schema.minLength) out.push(`${path}: is empty`);
  if (t === 'string' && schema.pattern && !new RegExp(schema.pattern).test(v)) out.push(`${path}: ${JSON.stringify(v)} does not match ${schema.pattern}`);
  if ((t === 'number' || t === 'integer') && (v < (schema.minimum ?? -Infinity) || v > (schema.maximum ?? Infinity))) out.push(`${path}: ${v} is out of range`);
  if (t === 'array') {
    if (v.length < (schema.minItems ?? 0)) out.push(`${path}: has ${v.length} items, needs ${schema.minItems}`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, `${path}[${i}]`, out));
  }
  if (t === 'object') {
    for (const k of schema.required ?? []) if (v[k] === undefined) out.push(`${path ? path + '.' : ''}${k}: missing`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (v[k] !== undefined) check(s, v[k], path ? `${path}.${k}` : k, out);
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties ?? {}))) out.push(`${path ? path + '.' : ''}${k}: not in the schema`);
  }
  return out;
}

// Every path in a row that holds a legacy placeholder.
function legacyPaths(v, path = '', out = []) {
  if (isLegacy(v)) out.push(path);
  else if (typeOf(v) === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'provenance') legacyPaths(x, path ? `${path}.${k}` : k, out);
  return out;
}

/** What is wrong with one history row, each problem naming the row: [] when it is a valid row. */
export function validate(row) {
  const out = check(HISTORY, row, '', []);
  const type = row?.event?.type;
  const decl = HISTORY.events.types[type];
  if (type && !decl) out.push(`event.type: ${type} is not declared in history.schema.json events`);
  if (decl) {
    if ((row.event.v ?? 1) > decl.v) out.push(`event.v: ${row.event.v} is newer than ${type} v${decl.v}`);
    for (const k of decl.required ?? []) if (row.event[k] === undefined) out.push(`event.${k}: missing (${type} needs it)`);
    if (decl.schema) check(decl.schema, row.event, 'event', out);
  }
  if (typeOf(row?.actor) === 'object' && !isLegacy(row.actor)) {
    const a = META.actors[row.actor.kind];
    if (!a) out.push(`actor.kind: ${row.actor.kind} is not a harness actor kind`);
    else if (a.id && !new RegExp(a.id).test(row.actor.id)) out.push(`actor.id: ${row.actor.id} is not a ${row.actor.kind} id`);
  }
  if (typeOf(row?.source) === 'object' && !isLegacy(row.source) && !META.sources[row.source.kind]) out.push(`source.kind: ${row.source.kind} is not a harness source kind`);
  const listed = row?.provenance?.placeholders ?? [];
  const found = legacyPaths(row ?? {});
  for (const p of found) if (!listed.includes(p)) out.push(`${p}: holds a legacy placeholder that provenance.placeholders does not list`);
  for (const p of listed) if (!found.includes(p)) out.push(`${p}: listed in provenance.placeholders but holds no legacy placeholder`);
  return out.map((p) => `${row?.id ?? '(no id)'}: ${p}`);
}

/** Legacy placeholders by source store or archive ref, then by path: { [ref]: { [path]: count } }. */
export function placeholders(rows) {
  const out = {};
  for (const r of rows)
    for (const p of r.provenance?.placeholders ?? []) {
      const by = (out[r.provenance.from.ref] ??= {});
      by[p] = (by[p] ?? 0) + 1;
    }
  return out;
}

/** The out-of-band rows, for doctor to list: who ordered what, by which message, skipping which gates. */
export const outOfBand = (rows) => rows.filter((r) => r.event.type === 'OUT_OF_BAND').map((r) => ({ id: r.id, at: r.at, ...r.event }));

/** The fact a row describes, as the first identity rule for its type keys it. */
export function factKey(row) {
  const rule = HISTORY.identity.rules.find((r) => r.types.includes(row.event.type));
  const parts = (rule ?? HISTORY.identity.otherwise).key.map((p) => get(row, p));
  if (!rule || parts.some((x) => x === undefined || isLegacy(x))) return `own:${row.provenance.from.ref}:${row.id}`;
  return `${rule.fact}:${parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('|')}`;
}

/**
 * One row per fact. Keeps the owner's row (else the earliest), moves the other sources to provenance.also, and
 * reports a conflict where two rows of one fact disagree on a payload field both carry. Two rows of one source are
 * never one fact: the n-th row of a key in a source, in time order, is that key's n-th fact.
 */
export function dedupe(rows) {
  const groups = new Map();
  const seen = new Map();
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const fact = factKey(r);
    const n = (seen.get(`${r.provenance.from.ref}\n${fact}`) ?? 0) + 1;
    seen.set(`${r.provenance.from.ref}\n${fact}`, n);
    const k = n > 1 ? `${fact}#${n}` : fact;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const kept = [], dropped = [], conflicts = [];
  for (const [key, group] of groups) {
    const owner = HISTORY.identity.rules.find((r) => r.types.includes(group[0].event.type))?.owner;
    const sorted = [...group].sort((a, b) => a.at.localeCompare(b.at));
    const keep = sorted.find((r) => r.provenance.from.source === owner) ?? sorted[0];
    const others = sorted.filter((r) => r !== keep);
    for (const o of others) {
      dropped.push({ id: o.id, from: o.provenance.from, kept: keep.id });
      for (const [f, v] of Object.entries(o.event))
        if (keep.event[f] !== undefined && !isLegacy(v) && !isLegacy(keep.event[f]) && JSON.stringify(v) !== JSON.stringify(keep.event[f]))
          conflicts.push({ fact: key, field: `event.${f}`, kept: keep.id, other: o.id });
    }
    kept.push(others.length ? { ...keep, provenance: { ...keep.provenance, also: [...(keep.provenance.also ?? []), ...others.map((o) => o.provenance.from)] } } : keep);
  }
  kept.sort((a, b) => a.at.localeCompare(b.at));
  return { rows: kept, dropped, conflicts };
}

/**
 * Everything that breaks a log view's needs file against the schema and, given rows, against a history: each line
 * starts with the view's name. A view names the event types it reads ("*" for all) and the fields of each: every row
 * of the type must carry each field, as a value or a legacy placeholder, and at least one row a value.
 */
export function checkLogNeeds(needs, rows) {
  const out = [];
  const say = (m) => out.push(`${needs.page}: ${m}`);
  const range = needs.reads.historySchema;
  if (HISTORY.schemaVersion < range.min || HISTORY.schemaVersion > range.max) say(`reads history schema ${range.min}..${range.max}, and history.schema.json is ${HISTORY.schemaVersion}`);
  for (const type of Object.keys(needs.events)) if (type !== '*' && !HISTORY.events.types[type]) say(`reads ${type}, which history.schema.json does not declare`);
  if (!rows) return out;
  for (const [type, fields] of Object.entries(needs.events)) {
    const of = rows.filter((r) => type === '*' || r.event.type === type);
    if (!of.length) { say(`reads ${type} events, and this history has none`); continue; }
    for (const f of fields) {
      const lack = of.filter((r) => get(r, f) === undefined).map((r) => r.id);
      if (!of.some((r) => get(r, f) !== undefined && !isLegacy(get(r, f)))) say(`reads ${type} field ${f}, which no ${type} event in this history has`);
      else if (lack.length) say(`reads ${type} field ${f}, which ${lack.length === 1 ? 'row' : 'rows'} ${lack.join(', ')} ${lack.length === 1 ? 'lacks' : 'lack'}`);
    }
  }
  return out;
}
