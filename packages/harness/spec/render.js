// Renders the JSON spec as SPEC.md: one Mermaid state diagram per machine, plus the effects each
// machine asks the host for. Run `npm run spec:render` after changing any *.machine.json.
import { writeFileSync } from 'node:fs';
import { specs, referencedNames } from '../src/machines.js';

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

const out = [
  '# Harness spec (generated)',
  '',
  'Generated from `packages/harness/spec/*.machine.json` by `npm run spec:render`. Do not edit by hand: change the JSON.',
  ''
];
for (const [name, config] of Object.entries(specs)) {
  const names = referencedNames(config);
  out.push(`## ${name} (v${config.version})`, '', config.description ?? '', '', '```mermaid', diagram(config), '```', '');
  out.push(`Effects and context updates: ${[...names.actions].sort().map((n) => `\`${n}\``).join(', ')}`, '');
  out.push(`Guards: ${[...names.guards].sort().map((n) => `\`${n}\``).join(', ') || 'none'}`, '');
}
writeFileSync(new URL('./SPEC.md', import.meta.url), out.join('\n'));
console.log('wrote packages/harness/spec/SPEC.md');
