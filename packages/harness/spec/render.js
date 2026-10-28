// Renders the JSON spec as SPEC.md: one Mermaid state diagram per machine, plus the effects each
// machine asks the host for. Run `npm run spec:render` after changing any *.machine.json.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { specs, referencedNames } from '../src/machines.js';
import { HISTORY } from '../src/history.js';

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const safe = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

function diagram(config) {
  const lines = ['stateDiagram-v2'];
  const resolve = (from, target) => {
    if (target.startsWith('#')) return target.slice(1).split('.').slice(1).join('.') || target.slice(1);
    if (target.startsWith('.')) return [...from, target.slice(1)].join('.');
    return [...from.slice(0, -1), target].join('.');
  };
  const edges = (path, on, label) => {
    for (const tr of asList(on)) {
      const t = typeof tr === 'string' ? { target: tr } : tr;
      if (!t.target) continue;
      const g = t.guard ? ` [${t.guard.type}${t.guard.params ? ' ' + JSON.stringify(t.guard.params) : ''}]` : '';
      lines.push(`  ${safe(path.join('.')) || '[*]'} --> ${safe(resolve(path, t.target))} : ${label}${g}`);
    }
  };
  const walk = (node, path) => {
    const states = Object.entries(node.states ?? {});
    for (const [key, child] of states) {
      const p = [...path, key];
      const id = safe(p.join('.'));
      lines.push(`  state "${key}${child.type === 'final' ? ' ✓' : ''}" as ${id}`);
      if ((child.tags ?? []).length) lines.push(`  note right of ${id} : ${child.tags.join(', ')}`);
    }
    if (node.initial) lines.push(`  [*] --> ${safe([...path, node.initial].join('.'))}`);
    for (const [key, child] of states) {
      const p = [...path, key];
      for (const [ev, on] of Object.entries(child.on ?? {})) edges(p, on, ev);
      edges(p, child.always, 'always');
      walk(child, p);
    }
  };
  walk(config, []);
  for (const [ev, on] of Object.entries(config.on ?? {}))
    for (const tr of asList(on))
      if (tr.target?.startsWith('.')) lines.push(`  note left of ${safe(tr.target.slice(1))} : from any state on ${ev}`);
  return lines.join('\n');
}

// Every state with its description and tags, in document order: the promises the diagram cannot show.
function states(node, path = [], rows = []) {
  for (const [key, child] of Object.entries(node.states ?? {})) {
    const p = [...path, key];
    const tags = (child.tags ?? []).map((t) => `\`${t}\``).join(', ');
    // meta.waitsOn: the effect that stays pending while the actor is in this state; harness doctor flags it missing.
    const waits = child.meta?.waitsOn ? ` (waits on a pending \`${child.meta.waitsOn}\`)` : '';
    if (child.description || tags || waits) rows.push(`- \`${p.join('.')}\`${tags ? ` (tags: ${tags})` : ''}${waits}${child.description ? `: ${child.description}` : ''}`);
    states(child, p, rows);
  }
  return rows;
}

// A guarded transition with no target and no actions refuses its event (snapshot.can() is false), so
// apply() writes nothing: these are the rules on who may send what.
function refusals(node, path = [], rows = []) {
  const at = path.length ? `\`${path.join('.')}\`` : 'any state';
  for (const [ev, on] of Object.entries(node.on ?? {}))
    for (const t of asList(on))
      if (t.guard && !t.target && !asList(t.actions).length)
        rows.push(`- \`${ev}\` in ${at}, when \`${t.guard.type}\`${t.guard.params ? ` ${JSON.stringify(t.guard.params)}` : ''}: ${t.description ?? 'refused'}`);
  for (const [key, child] of Object.entries(node.states ?? {})) refusals(child, [...path, key], rows);
  return rows;
}

export function renderSpec() {
  const out = [
    '# Harness spec (generated)',
    '',
    'Generated from `packages/harness/spec/*.machine.json` by `npm run spec:render`. Do not edit by hand: change the JSON.',
    ''
  ];
  for (const [name, config] of Object.entries(specs)) {
    const names = referencedNames(config);
    out.push(`## ${name} (v${config.version})`, '', config.description ?? '', '');
    // The actors an event may come from (meta.actors): the envelope and the role guards read them from here.
    const actors = Object.entries(config.meta?.actors ?? {});
    if (actors.length)
      out.push('Actors:', '', ...actors.map(([kind, a]) => `- \`${kind}\`${a.id ? ` (id \`${a.id}\`)` : ''}${a.roles ? ', holds roles' : ''}: ${a.description}`), '', config.meta.roles ?? '', '');
    // Where an event may come from (meta.sources): the envelope reads the kinds from here.
    const sources = Object.entries(config.meta?.sources ?? {});
    if (sources.length) out.push('Sources:', '', ...sources.map(([kind, d]) => `- \`${kind}\`: ${d}`), '');
    // What an agent actor may send, by its role on the item (meta.agentEvents): runtime.apply refuses the rest.
    const ae = config.meta?.agentEvents;
    if (ae)
      out.push(`Agent events (\`agentEvents\`): ${ae.description}`, '', ...Object.entries(ae.roles).map(([role, types]) => `- ${role}: ${types.map((t) => `\`${t}\``).join(', ')}`), '');
    // The refusals that live in host code: each one's name is what its refusal or deny site cites (test/rules.test.js).
    const invariants = Object.entries(config.meta?.invariants ?? {});
    if (invariants.length)
      out.push('Host invariants (refused or denied outside the machines; every such site in the code names one of these or a guard):', '', ...invariants.map(([k, v]) => `- \`${k}\`: ${v}`), '');
    // The host footer the merge gate and doctor tolerate after a verdict review (meta.reviewFooter).
    if (config.meta?.reviewFooter) out.push(`Review footer (\`reviewFooter\`): ${JSON.stringify(config.meta.reviewFooter.text)}. ${config.meta.reviewFooter.description}`, '');
    // The store layout pages read (meta.store) and how pages refresh (meta.pages).
    if (config.meta?.store) out.push(`Store: \`schemaVersion\` ${config.meta.store.schemaVersion}. ${config.meta.store.description}`, '');
    if (config.meta?.pages)
      out.push(`Pages: a refresh slower than ${config.meta.pages.refreshSlowMs} ms is flagged; rows go to \`${config.meta.pages.refreshCollection}\`. ${config.meta.pages.description}`, '');
    // The decision classes with their doors (meta.classes) and the grant checklist the machine generates (meta.checklist).
    if (config.meta?.classes)
      out.push('Decision classes:', '', ...Object.entries(config.meta.classes).map(([k, c]) => `- \`${k}\`: ${c.door} door. ${c.description}`), '', config.meta.doors ?? '', '');
    if (config.meta?.checklist) out.push(`Checklist: end times ${config.meta.checklist.endsAfterHours.join(', ')} hours after the ask. ${config.meta.checklist.description}`, '');
    out.push('```mermaid', diagram(config), '```', '');
    const rows = states(config);
    if (rows.length) out.push('States:', '', ...rows, '');
    const refused = refusals(config);
    if (refused.length) out.push('Refused (nothing changes and nothing is written):', '', ...refused, '');
    out.push(`Effects and context updates: ${[...names.actions].sort().map((n) => `\`${n}\``).join(', ')}`, '');
    out.push(`Guards: ${[...names.guards].sort().map((n) => `\`${n}\``).join(', ') || 'none'}`, '');
  }
  // The one history's row format (history.schema.json): provenance, placeholders, event versions and fact identity.
  const p = HISTORY.$defs.provenance.properties;
  out.push(`## History (schema v${HISTORY.schemaVersion})`, '', HISTORY.description, '');
  out.push(`Provenance: \`origin\` is one of ${p.origin.enum.map((o) => `\`${o}\``).join(', ')}. ${p.origin.description} \`from.source\` is one of ${HISTORY.$defs.from.properties.source.enum.map((s) => `\`${s}\``).join(', ')}. ${p.placeholders.description} ${HISTORY.$defs.legacy.description}`, '');
  out.push(`Events: ${HISTORY.events.description}`, '');
  out.push(...Object.entries(HISTORY.events.types).filter(([, d]) => d.required || d.description).map(([t, d]) => `- \`${t}\` v${d.v}${d.required ? `, needs ${d.required.map((f) => `\`${f}\``).join(', ')}` : ''}${d.description ? `: ${d.description}` : ''}`), '');
  out.push(`Identity: ${HISTORY.identity.description}`, '');
  out.push(...HISTORY.identity.rules.map((r) => `- ${r.fact} (${r.types.map((t) => `\`${t}\``).join(', ')}): key ${r.key.map((k) => `\`${k}\``).join(' + ')}, owner ${r.owner}. ${r.why}`), `- otherwise: key ${HISTORY.identity.otherwise.key.map((k) => `\`${k}\``).join(' + ')}. ${HISTORY.identity.otherwise.why}`, '');
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./SPEC.md', import.meta.url), renderSpec());
  console.log('wrote packages/harness/spec/SPEC.md');
}
