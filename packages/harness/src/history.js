// The one history (epic #59): every era's events in one shape, spec/history.schema.json. This module only
// reads that file: validate() holds a row to it (with the actor and source kinds from harness meta), eventProblems()
// holds an event's payload to its type's declaration (workItem's unrecordable guard reads it), upcast() migrates a
// row from a store that predates a field (E1), historyRows() reads a store's rows as a history (a live row's provenance), eraEnd() writes the row that ends a store's era, placeholders() counts the legacy values doctor reports by era and
// field, factKey() and dedupe() apply its identity rules, stepProblems() holds a step (steps, beside a history) to its row, usageProblems() a usage row (usage, read on demand) to its row, and
// checkLogNeeds() holds a history, its steps and its usage fields to a view's needs file. The schema is a subset of
// JSON Schema, and so is the checker below.
import { readFileSync } from 'node:fs';
import { specs } from './machines.js';

export const HISTORY = JSON.parse(readFileSync(new URL('../spec/history.schema.json', import.meta.url), 'utf8'));
// Read when used, not at load: machines.js imports this module for its guards.
const META = () => specs.harness.meta;

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
export function legacyPaths(v, path = '', out = []) {
  if (isLegacy(v)) out.push(path);
  else if (typeOf(v) === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'provenance') legacyPaths(x, path ? `${path}.${k}` : k, out);
  return out;
}

/**
 * A row from a store that predates a field, as E1 migrates it (history.schema.json upcast): each envelope field the
 * schema lists, and each field its event type needs, that the row lacks becomes a labelled legacy placeholder.
 * `store` is the archive ref the store is read as. A row with provenance is a history row already and is returned as is.
 */
export function upcast(row, store) {
  if (row?.provenance || typeOf(row) !== 'object') return row;
  const { envelope, legacy } = HISTORY.upcast;
  const say = (t, field) => ({ legacy: t.replaceAll('{store}', store).replaceAll('{field}', field).replaceAll('{type}', row.event?.type) });
  const out = { ...row };
  for (const f of envelope) if (out[f] === undefined) out[f] = say(legacy.envelope, f);
  const need = typeOf(row.event) === 'object' ? HISTORY.events.types[row.event.type]?.required ?? [] : [];
  if (need.some((k) => row.event[k] === undefined)) out.event = { ...row.event, ...Object.fromEntries(need.filter((k) => row.event[k] === undefined).map((k) => [k, say(legacy.event, `event.${k}`)])) };
  return out;
}

/**
 * The row that ends a store's era (harness meta.store.eras, history.schema.json ERA_ENDED): after its last row (`lastAt`),
 * carrying its state.json snapshot and the effects its outbox holds that its acks never close, each with the id its host
 * knows it by. No one sent it: its actor
 * and source are placeholders (upcast legacy.era), and so is its harness when state.json names no writer.
 */
export function eraEnd(store, state, outbox, acks, lastAt) {
  const say = { legacy: HISTORY.upcast.legacy.era.replaceAll('{store}', store) };
  const acked = new Set(acks.map((a) => a.effectId));
  const pending = outbox.filter((e) => !acked.has(e.id)).map(({ eventId, at, ...e }) => e);
  const at = [lastAt, state.updatedAt].filter(Boolean).sort().at(-1);
  const row = { id: `era:${store}`, version: 1, at, to: 'harness', actor: say, source: say, harness: state.writtenBy ?? say, event: { type: specs.harness.meta.store.eras.event, era: store, snapshot: state.snapshot, pending } };
  return { ...row, provenance: { origin: 'migrated', from: { source: 'store', ref: store }, placeholders: legacyPaths(row) } };
}

/**
 * A store's rows as a history (harness meta.store.history), or null when no row carries provenance: it is not one. Each
 * row with no provenance after the last row that has one is live, read with history.schema.json live's provenance, `store`
 * the history's name; the rows themselves are not changed.
 */
export function historyRows(rows, store) {
  const last = rows.findLastIndex((r) => r?.provenance);
  if (last < 0) return null;
  const { from, ...live } = HISTORY.live.provenance;
  const provenance = { ...live, from: { ...from, ref: from.ref.replaceAll('{store}', store) } };
  return rows.map((r, i) => (i > last && typeOf(r) === 'object' && r.provenance === undefined ? { ...r, provenance } : r));
}

/** What is wrong with one history row, each problem naming the row: [] when it is a valid row. */
export function validate(row) {
  const out = check(HISTORY, row, '', []);
  if (row?.event?.type) out.push(...eventProblems(row.event));
  if (typeOf(row?.actor) === 'object' && !isLegacy(row.actor)) {
    const a = META().actors[row.actor.kind];
    if (!a) out.push(`actor.kind: ${row.actor.kind} is not a harness actor kind`);
    else if (a.id && !new RegExp(a.id).test(row.actor.id)) out.push(`actor.id: ${row.actor.id} is not a ${row.actor.kind} id`);
  }
  if (typeOf(row?.source) === 'object' && !isLegacy(row.source) && !META().sources[row.source.kind]) out.push(`source.kind: ${row.source.kind} is not a harness source kind`);
  const listed = row?.provenance?.placeholders ?? [];
  const found = legacyPaths(row ?? {});
  for (const p of found) if (!listed.includes(p)) out.push(`${p}: holds a legacy placeholder that provenance.placeholders does not list`);
  for (const p of listed) if (!found.includes(p)) out.push(`${p}: listed in provenance.placeholders but holds no legacy placeholder`);
  return out.map((p) => `${row?.id ?? '(no id)'}: ${p}`);
}

/** What is wrong with one step of a history's steps file (history.schema.json steps.row): [] when it is a valid step. */
export const stepProblems = (step) => check(HISTORY.steps.row, step, '', []).map((p) => `step ${step?.version ?? '(no version)'}: ${p}`);
/** What is wrong with one row of a usage file (history.schema.json usage.row): [] when it is a valid row. */
export const usageProblems = (row) => check(HISTORY.usage.row, row, '', []);

/** What is wrong with an event's payload against its type's declaration (events.types): [] when it holds to it. */
export function eventProblems(event) {
  const { type } = event;
  const decl = HISTORY.events.types[type];
  if (!decl) return [`event.type: ${type} is not declared in history.schema.json events`];
  const out = [];
  if ((event.v ?? 1) > decl.v) out.push(`event.v: ${event.v} is newer than ${type} v${decl.v}`);
  for (const k of decl.required ?? []) if (event[k] === undefined) out.push(`event.${k}: missing (${type} needs it)`);
  if (decl.schema) check(decl.schema, event, 'event', out);
  return out;
}

/** A row's era: the store it was read from (its archive ref), else the kind of source (github, session, ...). */
const eraOf = (row) => (row.provenance.from.source === 'store' ? row.provenance.from.ref : row.provenance.from.source);

/** Legacy placeholders by era (eraOf), then by path: { [era]: { [path]: count } }. */
export function placeholders(rows) {
  const out = {};
  for (const r of rows)
    for (const p of r.provenance?.placeholders ?? []) {
      const by = (out[eraOf(r)] ??= {});
      by[p] = (by[p] ?? 0) + 1;
    }
  return out;
}

/** The out-of-band rows, for doctor to list: who ordered what, by which message, skipping which gates. */
export const outOfBand = (rows) => rows.filter((r) => r.event.type === 'OUT_OF_BAND').map((r) => ({ id: r.id, at: r.at, to: r.to, ...r.event }));

const ruleOf = (type) => HISTORY.identity.rules.find((r) => r.types.includes(type));
// A key path's value as its rule compares it: the first n characters where the rule abbreviates the path.
const keyPart = (rule, path, x) => (typeof x === 'string' && rule?.abbrev?.[path] ? x.slice(0, rule.abbrev[path]) : x);

/** The fact a row describes, as the first identity rule for its type keys it. */
export function factKey(row) {
  const rule = ruleOf(row.event.type);
  const parts = (rule ?? HISTORY.identity.otherwise).key.map((p) => get(row, p));
  if (!rule || parts.some((x) => x === undefined || isLegacy(x))) return `own:${row.provenance.from.ref}:${row.id}`;
  return `${rule.fact}:${parts.map((x, i) => keyPart(rule, rule.key[i], x)).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('|')}`;
}

/**
 * One row per fact (two rows of one source, or of two stores, are never one). Keeps the first owner's row (the rule's owners in order; else the earliest), moves the other sources to provenance.also, and
 * reports a conflict where two rows of one fact disagree on a payload field both carry. Two rows of one source are
 * never one fact: the n-th row of a key in a source, in time order, is that key's n-th fact.
 */
export function dedupe(rows) {
  const groups = new Map();
  const seen = new Map();
  // The stores count as one source: each is its own era, so two stores' rows are never one fact.
  const sourceOf = (r) => (r.provenance.from.source === 'store' ? 'store' : r.provenance.from.ref);
  for (const r of [...rows].sort((a, b) => a.at.localeCompare(b.at))) {
    const fact = factKey(r);
    const n = (seen.get(`${sourceOf(r)}\n${fact}`) ?? 0) + 1;
    seen.set(`${sourceOf(r)}\n${fact}`, n);
    const k = n > 1 ? `${fact}#${n}` : fact;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const kept = [], dropped = [], conflicts = [];
  for (const [key, group] of groups) {
    const rule = ruleOf(group[0].event.type);
    const sorted = [...group].sort((a, b) => a.at.localeCompare(b.at));
    const keep = (rule?.owner ?? []).map((o) => sorted.find((r) => r.provenance.from.source === o)).find(Boolean) ?? sorted[0];
    const others = sorted.filter((r) => r !== keep);
    for (const o of others) {
      dropped.push({ id: o.id, from: o.provenance.from, kept: keep.id });
      for (const [f, v] of Object.entries(o.event))
        if (keep.event[f] !== undefined && !isLegacy(v) && !isLegacy(keep.event[f]) && JSON.stringify(keyPart(rule, `event.${f}`, v)) !== JSON.stringify(keyPart(rule, `event.${f}`, keep.event[f])))
          conflicts.push({ fact: key, field: `event.${f}`, kept: keep.id, other: o.id });
    }
    kept.push(others.length ? { ...keep, provenance: { ...keep.provenance, also: [...(keep.provenance.also ?? []), ...others.map((o) => o.provenance.from)] } } : keep);
  }
  kept.sort((a, b) => a.at.localeCompare(b.at));
  return { rows: kept, dropped, conflicts };
}

// Whether the schema declares a field path: each segment a property (through $ref, anyOf and an array's items) of one
// of the nodes it starts from.
function declares(schema, nodes, path) {
  const ref = (n) => (n && n.$ref ? ref(n.$ref.slice(2).split('/').reduce((x, k) => x?.[k], schema)) : n);
  const forms = (n) => { n = ref(n); return !n ? [] : n.anyOf ? n.anyOf.flatMap(forms) : n.items ? [n, ...forms(n.items)] : [n]; };
  for (const k of path.split('.')) nodes = nodes.flatMap(forms).map((n) => n.properties?.[k]).filter(Boolean);
  return nodes.length > 0;
}
// A history field path for an event type: in the envelope, or for event.* in the type's own schema.
const declaresLog = (schema, type, path) =>
  declares(schema, [schema], path) || (path.startsWith('event.') && type !== '*' && Boolean(schema.events.types[type]?.schema) && declares(schema, [schema.events.types[type].schema], path.slice(6)));
// The values at a path, through arrays: one per object the path reaches, undefined where that object lacks it.
const valuesAt = (o, keys) => (!keys.length ? [o] : Array.isArray(o) ? o.flatMap((x) => valuesAt(x, keys)) : o == null || typeof o !== 'object' ? [undefined] : valuesAt(o[keys[0]], keys.slice(1)));

/**
 * Everything that breaks a log view's needs file against the schema and, given rows, against a history: each line
 * starts with the view's name. A view names the event types it reads ("*" for all) and the fields of each: the schema
 * must declare each field, every row of the type must carry it, as a value or a legacy placeholder, and at least one
 * row a value. A file it reads beside the history (reads.with: the steps or the usage file) has its fields declared in
 * the schema's steps.row or usage.row, and, given the steps (also), every step and every element on the way carries each one.
 */
export function checkLogNeeds(needs, rows, schema = HISTORY, also = {}) {
  const out = [];
  const say = (m) => out.push(`${needs.page}: ${m}`);
  const range = needs.reads.schemaVersion;
  if (schema.schemaVersion < range.min || schema.schemaVersion > range.max) say(`reads history schema ${range.min}..${range.max}, and history.schema.json is ${schema.schemaVersion}`);
  for (const [type, fields] of Object.entries(needs.events)) {
    if (type !== '*' && !schema.events.types[type]) { say(`reads ${type}, which history.schema.json does not declare`); continue; }
    for (const f of fields) if (!declaresLog(schema, type, f)) say(`reads ${type} field ${f}, which history.schema.json does not declare`);
  }
  // A file it reads beside the history (reads.with): the steps, one per row and joined to it by the schema's key, or
  // the usage rows, read with the history; each held to its own part of the schema.
  for (const [file, fields] of Object.entries(needs.reads.with ?? {})) {
    const part = ['steps', 'usage'].find((k) => schema[k]?.file === file);
    if (!part) { say(`reads ${file} beside the history, which history.schema.json does not declare`); continue; }
    for (const f of fields) if (!declares(schema, [schema[part].row], f)) say(`reads ${file} field ${f}, which history.schema.json ${part} does not declare`);
    // Only a file joined row by row holds every field on every row; usage rows differ by kind.
    if (!also[file] || !schema[part].key) continue;
    for (const f of fields) {
      const lack = also[file].filter((s) => valuesAt(s, f.split('.')).includes(undefined)).map((s) => s.version);
      if (lack.length) say(`reads ${file} field ${f}, which ${lack.length === 1 ? 'step' : 'steps'} ${lack.slice(0, 5).join(', ')}${lack.length > 5 ? ` and ${lack.length - 5} more` : ''} ${lack.length === 1 ? 'lacks' : 'lack'}`);
    }
  }
  // A file it reads only when a viewer opens a section (reads.onDemand: usage.jsonl), held to the schema's usage.row.
  for (const [file, fields] of Object.entries(needs.reads.onDemand ?? {})) {
    if (file !== schema.usage?.file) { say(`reads ${file} on demand, which history.schema.json does not declare`); continue; }
    for (const f of fields) if (!declares(schema, [schema.usage.row], f)) say(`reads ${file} field ${f}, which history.schema.json usage does not declare`);
  }
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
