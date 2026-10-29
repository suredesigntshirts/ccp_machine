// #155: the live pages read a history's rows by the rule doctor reads them by (harness meta.store.history,
// history.schema.json live): a row harness send appends after the join's rows is live, so the ledger, flow replay,
// design log and introspection render it, count it, and show no banner, at render (harness page --live) and on a
// Refresh, which runs the page's own inlined script. A row with no provenance before a joined row, and a store with
// no provenance anywhere, still get the banner. No network: the history is built with the current code in a temp
// folder, and the page script runs in a vm with a stand-in for the DOM and the Artifact files capability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { tempDir } from './tmp.js';
import { contractHistory } from '../src/sim.js';
import { parseLog } from '../src/live.js';

const BIN = fileURLToPath(new URL('../bin/harness.js', import.meta.url));
const USAGE = fileURLToPath(new URL('../scripts/history/usage.mjs', import.meta.url));
const LEAD = '2ce18a8f-fd3a-507a-82d3-2dea2ed3db49';
const PAGES = ['ledger', 'flow-replay', 'design-log', 'introspection'];
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const cli = (dir, ...args) => spawnSync(process.execPath, [BIN, '--dir', dir, ...args], { encoding: 'utf8', env });
const shown = (html) => html.slice(0, html.lastIndexOf('<script>'));
const BANNER = /class="banner bad"/;

// A joined history (the sim's contract store through extract-store.mjs and join.mjs) and two rows harness send
// appends to it, with the files the pages read beside it: steps.jsonl (harness replay --steps) and usage.jsonl
// (scripts/history/usage.mjs, here from no session ledgers).
let built;
async function history() {
  if (built) return built;
  const { dir } = await contractHistory(tempDir('harness-live-pages-live-rows-'));
  const joined = parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8')).length;
  for (const [id, n] of [['live-pages-d', 4], ['live-pages-e', 5]]) {
    const event = { type: 'REQUEST_RECEIVED', request: { id, title: id, project: 'ccp_machine', url: `https://github.com/suredesigntshirts/ccp_machine/issues/${n}` } };
    const r = cli(dir, 'send', JSON.stringify(event), '--id', `req-${id}`, '--actor', `session:${LEAD}`, '--source', 'cli:harness send');
    assert.equal(r.status, 0, r.stderr);
  }
  const rows = parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8'));
  assert.equal(rows.length, joined + 2);
  assert.ok(rows.slice(joined).every((r) => !('provenance' in r)), 'the live rows are as the runtime wrote them');
  sides(dir);
  return (built = { dir, rows, joined });
}
function sides(dir) {
  const replay = cli(dir, 'replay', '--steps');
  assert.ok(readFileSync(join(dir, 'steps.jsonl'), 'utf8').trim(), replay.stderr || replay.stdout);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const usage = spawnSync(process.execPath, [USAGE, join(dir, 'sessions'), join(dir, 'events.jsonl')], { encoding: 'utf8', env });
  assert.equal(usage.status, 0, usage.stderr);
  writeFileSync(join(dir, 'usage.jsonl'), usage.stdout);
}
// The same history with its rows changed, in a folder of its own, with its steps and usage built again.
function variant(dir, change) {
  const out = tempDir('harness-live-pages-live-rows-variant-');
  copyFileSync(join(dir, 'state.json'), join(out, 'state.json'));
  for (const f of ['outbox.jsonl', 'acks.jsonl']) try { copyFileSync(join(dir, f), join(out, f)); } catch {}
  const rows = change(parseLog(readFileSync(join(dir, 'events.jsonl'), 'utf8')));
  writeFileSync(join(out, 'events.jsonl'), rows.map((r) => JSON.stringify(r) + '\n').join(''));
  writeFileSync(join(out, 'steps.jsonl'), readFileSync(join(dir, 'steps.jsonl')));
  writeFileSync(join(out, 'usage.jsonl'), readFileSync(join(dir, 'usage.jsonl')));
  return out;
}
const bare = ({ provenance, ...r }) => r;

function render(dir, page) {
  const html = join(dir, `${page}-live.html`);
  const r = cli(dir, 'page', '--live', '--page', page, '--project', 'chan_x', '--files-path', 'harness/state/history', '--html', html);
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(html, 'utf8');
}

// The page's own script (live.js inlined, then client(cfg, meta)) in a vm: a stand-in DOM holds the elements it uses,
// and window.claude.use('files') reads each file the page asks for from `dir`. Presses Refresh and returns #view and
// #data-age as the script left them.
async function refresh(html, dir) {
  const src = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const els = {};
  const handlers = {};
  const el = (id) => (els[id] ??= { id, textContent: '', innerHTML: '', disabled: false, addEventListener: (type, fn) => { if (id === 'refresh' && type === 'click') handlers.refresh = fn; } });
  const read = async (path) => {
    const bytes = readFileSync(join(dir, path.split('/').at(-1)));
    return { bytes: new Uint8Array(bytes), size: bytes.length };
  };
  const window = { claude: { use: async (name) => (name === 'files' ? { read } : null) } };
  const ctx = vm.createContext({ document: { getElementById: el, addEventListener() {} }, window, performance, TextDecoder, console });
  vm.runInContext(src, ctx);
  assert.ok(handlers.refresh, 'the page script binds Refresh');
  await handlers.refresh();
  return { view: els.view.innerHTML, age: els['data-age'].textContent, msg: els['refresh-msg'].textContent };
}

test('#155: each history page renders a joined history with live rows after it: data, no banner, the live rows counted', async () => {
  const { dir, rows } = await history();
  for (const page of PAGES) {
    const html = shown(render(dir, page));
    assert.doesNotMatch(html, BANNER, `${page}: ${/class="banner bad"[^>]*>(.*?)<\/div>/.exec(html)?.[1]}`);
    assert.match(html, new RegExp(`: ${rows.length} rows`), `${page} counts every row, the live ones too`);
  }
  const ledger = shown(render(dir, 'ledger'));
  assert.match(ledger, new RegExp(`data-count="rows"[^>]*>${rows.length}<`), 'the ledger total counts the live rows');
  assert.match(ledger, /<tr data-era="history"><td class="m">history<\/td><td class="m">live ×2<\/td><td><b data-count="rows">2<\/b>/, 'the live rows are read as the history\'s own (history.schema.json live)');
});

test('#155: Refresh, the page\'s own script, reads the live history by the same rule: data, no banner, the live rows counted', async () => {
  const { dir, rows } = await history();
  for (const page of PAGES) {
    const r = await refresh(render(dir, page), dir);
    assert.doesNotMatch(r.view, BANNER, `${page} on Refresh: ${/class="banner bad"[^>]*>(.*?)<\/div>/.exec(r.view)?.[1]}`);
    assert.match(r.msg, /^Refreshed in /, page);
    assert.match(r.age, new RegExp(`: ${rows.length} rows`), `${page} on Refresh counts every row, the live ones too`);
  }
});

test('#155: a row with no provenance before a joined row, and a store with no provenance anywhere, still get the banner, at render and on Refresh', async () => {
  const { dir, joined } = await history();
  const corrupt = variant(dir, (rows) => rows.map((r, i) => (i === 1 ? bare(r) : r)));
  const none = variant(dir, (rows) => rows.map(bare));
  assert.ok(joined > 2);
  for (const page of PAGES) {
    for (const [what, d, line] of [['a joined row without provenance', corrupt, 2], ['no provenance anywhere', none, 1]]) {
      const said = new RegExp(`class="banner bad"[^>]*><b>Wrong history layout\\.</b> Line ${line} of this events\\.jsonl is not a history row`);
      const html = render(d, page);
      assert.match(shown(html), said, `${page}, ${what}, at render`);
      const r = await refresh(html, d);
      assert.match(r.view, said, `${page}, ${what}, on Refresh`);
    }
  }
});
