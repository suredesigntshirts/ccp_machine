// Fails when files under plugins/harness differ from the base branch but plugin.json's version is not
// higher than the base's, so a version always names one build of the plugin (a synced copy has no git).
// Usage, from the repo root: node scripts/check-plugin-version.mjs <base ref>   (CI: origin/<PR base>)
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';
const dir = 'plugins/harness';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const semver = (v) => String(v).split('.').map(Number);
const higher = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const changed = git('diff', '--name-only', `${base}...HEAD`, '--', dir).trim();
if (!changed) {
  console.log(`${dir} unchanged against ${base}`);
  process.exit(0);
}
const manifest = `${dir}/.claude-plugin/plugin.json`;
let was = '0.0.0';
try { was = JSON.parse(git('show', `${base}:${manifest}`)).version; } catch {} // new plugin
const now = JSON.parse(git('show', `HEAD:${manifest}`)).version;
if (!higher(now, was)) {
  console.error(`${dir} changed against ${base} (${changed.split('\n').join(', ')}) but its version is ${now}, base ${was}: bump "version" in ${manifest}`);
  process.exit(1);
}
console.log(`${dir} changed against ${base}; version ${was} -> ${now}`);
