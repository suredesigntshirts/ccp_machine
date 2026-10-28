// No refusal lives only in host code (#36). Every `refused:` the harness source writes, and every deny the plugin's
// hooks return, cites the rule it enforces: a guard of a machine JSON, or a host invariant the spec names
// (harness meta.invariants, shown in SPEC.md). `machine` cites the machine's own refusal (snapshot.can), whose
// reason names the guard. A new refusal or deny that cites nothing, or cites a name the spec does not hold, fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { specs, referencedNames } from '../src/machines.js';

const names = new Set(['machine', ...Object.keys(specs.harness.meta.invariants ?? {}), ...(specs.harness.meta.agentEvents ? ['agentEvents'] : [])]);
for (const config of Object.values(specs)) for (const g of referencedNames(config).guards) names.add(g);

const files = (dir) => readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [`${dir.pathname ?? dir}${f}`, readFileSync(new URL(f, dir), 'utf8').split('\n')]);
const src = new URL('../src/', import.meta.url);
const hooks = new URL('../../../plugins/harness/scripts/', import.meta.url);

test('every refused: in packages/harness/src cites a guard or a named host invariant (// rule: <name>)', () => {
  let sites = 0;
  for (const [file, lines] of files(src))
    lines.forEach((line, i) => {
      if (!/[`'"]refused: /.test(line) || /^\s*(\*|\/\/)/.test(line)) return; // code, not comments
      sites++;
      const cited = /\/\/ rule: (\w+)/.exec(line)?.[1] ?? /\/\/ rule: (\w+)/.exec(lines[i - 1] ?? '')?.[1];
      assert.ok(cited, `${file}:${i + 1} refuses without citing its rule (// rule: <guard or invariant>)`);
      assert.ok(names.has(cited), `${file}:${i + 1} cites "${cited}", which is neither a guard nor a host invariant in the spec`);
    });
  assert.ok(sites >= 4, 'the runtime refusals were found');
});

test("every deny in the plugin's hooks goes through deny(<rule>, why) with a guard or a named host invariant", () => {
  let calls = 0;
  for (const [file, lines] of files(hooks))
    lines.forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return; // code, not comments
      if (/['"]deny['"]/.test(line)) assert.match(line, /export const deny = /, `${file}:${i + 1} denies outside deny(): cite a rule through deny(<rule>, why)`);
      for (const m of line.matchAll(/\bdeny\(([^,)]*)/g)) {
        if (/export const deny = /.test(line)) continue;
        calls++;
        const rule = /^\s*'(\w+)'\s*$/.exec(m[1])?.[1];
        assert.ok(rule, `${file}:${i + 1} calls deny(${m[1]}): the rule must be a literal name`);
        assert.ok(names.has(rule), `${file}:${i + 1} denies citing "${rule}", which is neither a guard nor a host invariant in the spec`);
      }
    });
  assert.ok(calls >= 1, 'the hooks deny somewhere');
});
